'use strict';

// Film take execution: resolves a segment's inputs from the project (previous
// take's last frame, reference bank media), writes the H3 prompt with the
// film's running context, runs one ComfyUI job through the shared take
// runner, stores the clip locally, and extracts its last frame. Also approve
// (beat summary + next segment), export (ffmpeg concat) and capture-from-take.
//
// No workflows, no steps: the graph is built straight from the model entry,
// the project's format/gen settings and the resolved refs.

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const comfyui   = require('./comfyui');
const llm       = require('./llm');
const skills    = require('./skills');
const ffmpegDefault = require('./ffmpeg');
const videoTake = require('./videoTake');
const projects  = require('./projects');
const { buildWorkflow, archMeta, getDefaults } = require('../workflows');
const { buildVideoMessages, refineVideoPrompt } = require('../steps/video');
const { buildInitialMessages, buildNotesSummary, combineContext } = require('../steps/generate');
const { fitToBudget } = require('../lib/imageSize');

const TAIL_MAX_SEC = 15;   // reference clips must be 2–15 s
const TAIL_MIN_SEC = 2;
const TAIL_KEEP_SEC = 10;  // when trimming, keep this much of the end

function shortId() { return uuidv4().replace(/-/g, '').slice(0, 8); }
function httpError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function extOf(file) { return path.extname(file).toLowerCase() || '.bin'; }

function refMediaOf(project, segment) {
  const used = segment.refIds.map(id => project.refs.find(r => r.id === id)).filter(Boolean);
  const images = [], audios = [];
  for (const ref of used) {
    for (const media of ref.media) {
      if (media.type === 'image') images.push({ ref, media });
      else if (media.type === 'audio') audios.push({ ref, media });
    }
  }
  return { used, images, audios };
}

async function uploadLocalFile(project, rel, name) {
  const buf = fs.readFileSync(projects.mediaPath(project.id, rel));
  return comfyui.uploadInputFile(buf, name);
}

function capList(list, max, what, warnings) {
  if (list.length <= max) return list;
  warnings.push(`At most ${max} ${what} can go into one take — using the first ${max} of ${list.length}`);
  return list.slice(0, max);
}

// → { mode, checkpoint, inputRef, isI2V, lastFrameRef, referenceRefs, referenceVideos,
//     referenceAudios, isR2V, pictures, audios, videos, otherImages, visionImages, warnings, inputs }
// `upload: false` resolves everything without touching ComfyUI (prompt preview).
async function resolveInputs({ project, segment, cfg, modelConfig, ffmpeg = ffmpegDefault, signal, upload = true }) {
  const uploadLocal = upload ? uploadLocalFile : async (_p, rel) => ({ filename: path.basename(rel), subfolder: '', type: 'input' });
  const arch     = modelConfig.architecture;
  const archInfo = archMeta[arch] ?? {};
  const warnings = [];
  const mode     = segment.start?.mode ?? 'cut';
  const prev     = projects.previousApprovedTake(project, segment.index);
  const { images, audios } = refMediaOf(project, segment);
  const tag = `film-${project.id.slice(0, 8)}-${segment.id}-${shortId()}`;

  const out = {
    mode, checkpoint: 'fl2va', inputRef: null, isI2V: false, lastFrameRef: null,
    referenceRefs: [], referenceVideos: [], referenceAudios: [], isR2V: false,
    pictures: [], audios: [], videos: [], otherImages: [], visionImages: [], warnings,
    inputs: { firstFrame: null, refImages: [], refVideos: [], refAudios: [] },
    prevTake: prev?.take ?? null,
  };

  if (mode === 'bridge') throw httpError('bridge mode is not available yet — use continue or cut');

  if (mode === 'continue') {
    let rel, label;
    // An explicitly chosen start image wins over the previous take's last frame —
    // the user picked it on purpose (e.g. a generated keyframe for a new scene).
    if (segment.start?.startImage) {
      const { refId, mediaId } = segment.start.startImage;
      const ref = project.refs.find(r => r.id === refId);
      const media = ref?.media.find(m => m.id === mediaId);
      if (!media) throw httpError('The chosen start image is no longer in the reference bank');
      rel = media.file; label = `start image (${ref.name})`;
    } else if (prev?.take?.lastFrame) {
      rel = prev.take.lastFrame; label = `last frame of segment ${prev.segment.index + 1}`;
    } else {
      throw httpError(`Segment ${segment.index + 1} has nothing to continue from — approve segment ${segment.index} first, pick a start image, or switch to cut`);
    }
    out.inputRef = await uploadLocal(project, rel, `${tag}-start${extOf(rel)}`);
    out.isI2V = true;
    out.inputs.firstFrame = rel;
    out.visionImages.push({ label, file: rel });
    out.otherImages = images;
    for (const { ref, media } of images) out.visionImages.push({ label: `${ref.name} (${ref.kind})`, file: media.file });
    if (audios.length) warnings.push('Voice references only apply in cut mode — ignored for this continue segment');
    return out;
  }

  // cut → Ref2VA with bank media (and optionally the previous take's tail)
  out.checkpoint = 'ref2va';
  const maxImages = archInfo.maxReferences   ?? 9;
  const maxAudios = archInfo.referenceAudios ?? 3;
  const maxVideos = archInfo.referenceVideos ?? 3;
  const pics = capList(images, maxImages, 'reference images', warnings);
  const auds = capList(audios, maxAudios, 'reference audio clips', warnings);

  if (segment.start?.includePrevTail && prev?.take?.localFile) {
    const clipRel = prev.take.localFile;
    const dur = prev.take.durationSec ?? (await ffmpeg.probe(projects.mediaPath(project.id, clipRel))).durationSec ?? 0;
    if (dur < TAIL_MIN_SEC) {
      warnings.push(`Previous take is shorter than ${TAIL_MIN_SEC}s — not usable as a reference clip`);
    } else {
      let tailRel = clipRel;
      if (dur > TAIL_MAX_SEC) {
        tailRel = clipRel.replace(/\.mp4$/i, '') + '-tail.mp4';
        await ffmpeg.extractClip(projects.mediaPath(project.id, clipRel), Math.max(0, dur - TAIL_KEEP_SEC), dur, projects.mediaPath(project.id, tailRel), { signal });
      }
      const ref = await uploadLocal(project, tailRel, `${tag}-tail.mp4`);
      out.referenceVideos.push({ ...ref, audio: !prev.take.silent });
      out.videos.push({ label: `the last ${Math.min(dur, TAIL_KEEP_SEC).toFixed(1)}s of segment ${prev.segment.index + 1}${prev.take.silent ? ' (silent)' : ', with its soundtrack'}`, file: tailRel });
      out.inputs.refVideos.push(tailRel);
    }
  } else if (segment.start?.includePrevTail) {
    warnings.push('No previous approved take to include as a reference clip');
  }

  for (const { ref, media } of pics) {
    const r = await uploadLocal(project, media.file, `${tag}-pic${out.referenceRefs.length}${extOf(media.file)}`);
    out.referenceRefs.push(r);
    out.pictures.push({ ref, media });
    out.inputs.refImages.push(media.file);
    out.visionImages.push({ label: `<Picture ${out.pictures.length}> ${ref.name} (${ref.kind})`, file: media.file });
  }
  for (const { ref, media } of auds) {
    const r = await uploadLocal(project, media.file, `${tag}-aud${out.referenceAudios.length}${extOf(media.file)}`);
    out.referenceAudios.push(r);
    out.audios.push({ ref, media });
    out.inputs.refAudios.push(media.file);
  }

  const anyRefs = out.referenceRefs.length + out.referenceVideos.length + out.referenceAudios.length > 0;
  if (!anyRefs) {
    warnings.push('No references selected — this cut runs as plain text-to-video');
    out.checkpoint = 'fl2va';
    return out;
  }
  if (!archInfo.referenceToVideo) throw httpError(`${arch} has no reference-to-video mode — use continue`);
  for (const field of ['refUnetName', ...(archInfo.referenceToVideoRequires ?? [])]) {
    if (!modelConfig[field]) {
      const label = archInfo.fieldLabels?.[field] ?? field;
      throw httpError(`Cut segments need "${label}" set on model "${modelConfig.label ?? modelConfig.id}" (Models page)`);
    }
  }
  out.isR2V = true;
  return out;
}

// Pure: the film-level context appended to the prompt writer's system message.
function buildFilmContext(project, segment, resolved) {
  const lines = [];
  lines.push('FILM CONTEXT — this prompt is one shot of a longer film built shot by shot. Keep names, looks, places and tone consistent with what came before.');
  if (project.logline?.trim()) lines.push(`Logline: ${project.logline.trim()}`);
  const beats = project.script.filter(b => b.beat?.trim());
  if (beats.length) {
    lines.push('Story so far:');
    beats.forEach((b, i) => lines.push(`  ${i + 1}. ${b.beat.trim()}`));
  }
  const fps = project.format?.fps || 24;
  const secs = ((segment.frames ?? project.gen?.frames ?? 124) / fps).toFixed(1);
  const total = project.segments.length;
  const how = resolved.mode === 'continue'
    ? (resolved.prevTake && resolved.inputs?.firstFrame === resolved.prevTake.lastFrame
        ? 'It continues directly from the previous shot: the given first frame is where the previous take ended, so the motion must pick up from that exact moment.'
        : 'It starts from the given image as its first frame.')
    : (resolved.isR2V
        ? 'It is a new shot (a cut) built from the references below — a fresh framing, not a continuation of the previous frame.'
        : 'It is a new shot with no visual references.');
  lines.push(`This shot: segment ${segment.index + 1} of ${total}, about ${secs}s. ${how}`);
  const refLines = [];
  resolved.pictures?.forEach(({ ref }, i) => refLines.push(`  <Picture ${i + 1}> ${ref.name} (${ref.kind})${ref.description ? `: ${ref.description}` : ''}`));
  resolved.videos?.forEach((v, k) => refLines.push(`  <Video ${k + 1}> ${v.label}`));
  resolved.audios?.forEach(({ ref }, j) => refLines.push(`  <Audio ${j + 1}> ${ref.name} (${ref.kind})${ref.description ? `: ${ref.description}` : ''}`));
  if (refLines.length) { lines.push('References fed to the model in this shot:'); lines.push(...refLines); }
  if (resolved.otherImages?.length) {
    lines.push('Characters and places in this shot (shown to you for consistency; not fed to the model — describe them so they match):');
    for (const { ref } of resolved.otherImages) lines.push(`  ${ref.name} (${ref.kind})${ref.description ? `: ${ref.description}` : ''}`);
  }
  return lines.join('\n');
}

// Pure: earlier takes of this segment, so the writer fixes what the user
// rejected instead of repeating it. Rejected takes with notes matter most;
// undecided takes are listed so the next attempt is a real variation.
function buildAttemptsContext(segment, { max = 4 } = {}) {
  const takes = (segment.takes ?? []).slice(-max);
  if (!takes.length) return null;
  const lines = [`PREVIOUS ATTEMPTS at this shot (${segment.takes.length} so far). Write a NEW prompt: keep what was approved of, change what the notes reject, and do not repeat a rejected prompt verbatim.`];
  takes.forEach((t, i) => {
    const n = segment.takes.length - takes.length + i + 1;
    const verdict = t.verdict === 'rejected' ? 'REJECTED' : t.verdict === 'approved' ? 'approved' : 'undecided';
    lines.push(`  Take ${n} — ${verdict}${t.note?.trim() ? `; the director said: "${t.note.trim()}"` : ''}`);
    lines.push(`    prompt used: ${(t.prompt ?? '').trim().replace(/\s+/g, ' ').slice(0, 600)}`);
  });
  const rejectedNotes = takes.filter(t => t.verdict === 'rejected' && t.note?.trim());
  if (rejectedNotes.length) lines.push('The rejection notes above are the priority — the next prompt must address every one of them.');
  return lines.join('\n');
}

function readBase64(project, rel) {
  try { return fs.readFileSync(projects.mediaPath(project.id, rel)).toString('base64'); } catch { return null; }
}

// Writes this segment's prompt with the LLM (streams tokens). Falls back to the
// raw intent when refinement is off or the LLM call fails.
async function writeFilmPrompt({ project, segment, cfg, modelConfig, resolved, onToken, signal }) {
  const intent = (segment.intent ?? '').trim() || (project.logline ?? '').trim() || 'continue the scene';
  if (cfg.promptRefinement === false) return intent;
  const arch = modelConfig.architecture;
  const skillSummary = cfg.skillRefinement !== false ? skills.getSummary(modelConfig.id ?? project.modelId, arch) : null;
  const context = [skillSummary, buildFilmContext(project, segment, resolved), buildAttemptsContext(segment)].filter(Boolean).join('\n\n');
  const messages = buildVideoMessages(intent, arch, {
    isI2V: resolved.isI2V,
    refCount: resolved.referenceRefs.length,
    videoRefCount: resolved.referenceVideos.length,
    audioRefCount: resolved.referenceAudios.length,
    hasLastFrame: !!resolved.lastFrameRef,
    steering: segment.steering,
  }, context);
  if (cfg.llmExtras !== false) {
    // Show the writer where the last rejected take ended, so "she never turned
    // around" is grounded in what was actually rendered.
    const lastRejected = [...(segment.takes ?? [])].reverse().find(t => t.verdict === 'rejected' && t.lastFrame);
    const vision = [...resolved.visionImages];
    if (lastRejected) vision.push({ label: `last frame of the REJECTED take${lastRejected.note?.trim() ? ` ("${lastRejected.note.trim()}")` : ''}`, file: lastRejected.lastFrame });
    const labelled = vision.map(v => ({ label: v.label, b64: readBase64(project, v.file) })).filter(v => v.b64);
    if (labelled.length) {
      messages.splice(1, 0, {
        role: 'user',
        content: `Images for this shot, in order: ${labelled.map((v, i) => `${i + 1}. ${v.label}`).join('; ')}.`,
        images: labelled.map(v => v.b64),
      });
    }
  }
  return refineVideoPrompt(cfg, messages, onToken, signal, intent);
}

function cleanGen(gen = {}) {
  const out = {};
  for (const [k, v] of Object.entries(gen)) if (v !== null && v !== undefined && v !== '') out[k] = v;
  return out;
}

// Runs one take for a segment. `emit(event, data)` gets take_start, phase,
// token, prompt, progress, warning, video, take_complete. `save(project)`
// persists between stages. Returns the stored take.
async function runTake({ project, segment, cfg, emit = () => {}, prompt = null, seed = null, signal, isKilled = () => false, save = p => projects.saveProject(p), ffmpeg = ffmpegDefault }) {
  const modelConfig = projects.filmModel(cfg, project.modelId);
  const takeId = shortId();
  const tag = `${project.id.slice(0, 8)}/seg${segment.index + 1}`;
  const prevStatus = segment.status;
  segment.status = 'running';
  save(project);
  emit('take_start', { segmentId: segment.id, takeId });

  const clipRel  = `clips/seg${segment.index + 1}-${takeId}.mp4`;
  const frameRel = `clips/seg${segment.index + 1}-${takeId}-last.png`;
  const cleanup = () => { for (const rel of [clipRel, frameRel]) { try { fs.unlinkSync(projects.mediaPath(project.id, rel)); } catch { /* none */ } } };

  try {
    if (isKilled()) throw new Error('Generation stopped by user');
    const resolved = await resolveInputs({ project, segment, cfg, modelConfig, ffmpeg, signal });
    for (const w of resolved.warnings) { emit('warning', { message: w }); console.warn(`[${tag}] ${w}`); }

    let finalPrompt = (prompt ?? '').trim();
    if (!finalPrompt) {
      emit('phase', { phase: 'prompt_building' });
      finalPrompt = await writeFilmPrompt({ project, segment, cfg, modelConfig, resolved, onToken: token => emit('token', { token, phase: 'prompt' }), signal });
    }
    if (isKilled()) throw new Error('Generation stopped by user');
    emit('prompt', { prompt: finalPrompt });

    const usedSeed = videoTake.pickSeed({ seed: seed ?? segment.seed });
    const params = {
      ...modelConfig,
      ...project.format,
      ...cleanGen(project.gen),
      frames: segment.frames ?? project.gen?.frames ?? 124,
      seed: usedSeed,
      ...(segment.loras?.length ? { loras: segment.loras } : {}),
      positivePrompt: finalPrompt,
      inputRef: resolved.inputRef, isI2V: resolved.isI2V, lastFrameRef: resolved.lastFrameRef,
      referenceRefs: resolved.referenceRefs, referenceVideos: resolved.referenceVideos, referenceAudios: resolved.referenceAudios,
      isR2V: resolved.isR2V,
    };
    const { workflow } = buildWorkflow(modelConfig, params);

    emit('phase', { phase: 'generating' });
    console.log(`[${tag}] queuing take ${takeId} (${resolved.mode}, ${resolved.checkpoint})…`);
    const { videoRef, warnings: takeWarnings } = await videoTake.generateTake({ workflow, cfg, signal, isKilled, emit, tag });

    emit('phase', { phase: 'saving' });
    await comfyui.downloadOutput(videoRef, projects.mediaPath(project.id, clipRel), { signal });
    if (isKilled()) throw new Error('Generation stopped by user');
    const info = await ffmpeg.probe(projects.mediaPath(project.id, clipRel));
    await ffmpeg.extractLastFrame(projects.mediaPath(project.id, clipRel), projects.mediaPath(project.id, frameRel), { signal });

    const take = projects.addTake(project, segment.id, {
      id: takeId, prompt: finalPrompt, intent: segment.intent ?? '', seed: usedSeed,
      startMode: resolved.mode, checkpoint: resolved.checkpoint, refIds: [...segment.refIds],
      ...(segment.loras?.length ? { loras: segment.loras.map(l => ({ ...l })) } : {}),
      inputs: resolved.inputs, comfyVideo: videoRef,
      localFile: clipRel, lastFrame: frameRel, videoUrl: projects.mediaUrl(project.id, clipRel),
      durationSec: info.durationSec, silent: !info.hasAudio,
      warnings: [...resolved.warnings, ...takeWarnings],
    });
    segment.status = prevStatus === 'running' ? 'draft' : prevStatus;
    save(project);
    console.log(`[${tag}] take ${takeId} stored — ${clipRel}`);
    emit('take_complete', { take });
    return take;
  } catch (err) {
    cleanup();
    segment.status = prevStatus === 'running' ? 'draft' : prevStatus;
    save(project);
    throw err;
  }
}

// One past-tense line for the running script; falls back to the intent.
async function summarizeBeat(cfg, segment, take) {
  const fallback = (segment.intent || take.prompt || '').trim().slice(0, 140);
  if (!cfg.llmModel) return { beat: fallback };
  try {
    const result = await llm.chat(cfg, [
      { role: 'system', content: 'You keep the running script of a film that is generated shot by shot. Given the director\'s intent and the video prompt used for the latest shot, write ONE past-tense line under 20 words stating what happened on screen. Keep character and place names exactly as given. Output only that line.' },
      { role: 'user', content: `Intent: ${segment.intent || '(none)'}\n\nPrompt used:\n${take.prompt}` },
    ]);
    const text = (typeof result === 'string' ? result : result?.text ?? '').trim().split('\n')[0].trim();
    return { beat: text || fallback };
  } catch (e) {
    return { beat: fallback, warning: `Could not summarise the beat (${e.message}) — using the intent` };
  }
}

// Approve a take: it becomes the segment's output, later built segments go
// stale, the script gains a beat, and a fresh draft segment follows if none does.
async function approveTake({ project, segment, take, cfg, note = '' }) {
  const { staled } = projects.setVerdict(project, segment.id, take.id, 'approved', note);
  const { beat, warning } = await summarizeBeat(cfg, segment, take);
  projects.setBeat(project, segment.id, beat);
  let nextSegment = null;
  if (segment.index === project.segments.length - 1) nextSegment = projects.addSegment(project);
  return { staled, beat, warning, nextSegment };
}

// Stitch the approved takes (non-stale segments, timeline order) into one file.
async function exportProject({ project, ffmpeg = ffmpegDefault, signal }) {
  const takes = project.segments
    .filter(s => s.status === 'approved' && s.approvedTakeId)
    .map(s => s.takes.find(t => t.id === s.approvedTakeId))
    .filter(t => t?.localFile);
  if (!takes.length) throw httpError('Nothing to export — approve at least one take first');
  const missing = takes.find(t => !fs.existsSync(projects.mediaPath(project.id, t.localFile)));
  if (missing) throw httpError(`Clip file missing for take ${missing.id} (${missing.localFile})`, 409);
  const rel = 'export/export.mp4';
  const out = projects.mediaPath(project.id, rel);
  const result = await ffmpeg.concat(takes.map(t => projects.mediaPath(project.id, t.localFile)), out, { signal });
  const durationSec = takes.reduce((s, t) => s + (t.durationSec ?? 0), 0);
  return { file: rel, url: projects.mediaUrl(project.id, rel), durationSec, clips: result.clips, reencoded: result.reencoded };
}

// Capture a frame (t seconds) or an audio range from a take into the bank.
async function captureFromTake({ project, take, frame, audio, refId, newRef, ffmpeg = ffmpegDefault }) {
  if (!take.localFile) throw httpError('This take has no local clip to capture from');
  const src = projects.mediaPath(project.id, take.localFile);
  const ref = refId ? projects.findRef(project, refId) : projects.addRef(project, newRef ?? { kind: 'character', name: 'Captured' });
  const stamp = `${Date.now().toString(36)}${shortId().slice(0, 4)}`;
  let media;
  if (Array.isArray(audio)) {
    const [a, b] = audio.map(Number);
    if (!(b > a) || a < 0) throw httpError('audio must be [from, to] seconds with to > from');
    const rel = `refs/${ref.id}-${stamp}.wav`;
    await ffmpeg.extractAudio(src, a, b, projects.mediaPath(project.id, rel));
    media = projects.addRefMedia(project, ref.id, { type: 'audio', file: rel, source: { type: 'clip-audio', takeId: take.id, from: a, to: b } });
  } else {
    const t = Number(frame ?? 0);
    if (!(t >= 0)) throw httpError('frame must be a time in seconds');
    const rel = `refs/${ref.id}-${stamp}.png`;
    await ffmpeg.extractFrame(src, t, projects.mediaPath(project.id, rel));
    media = projects.addRefMedia(project, ref.id, { type: 'image', file: rel, source: { type: 'clip-frame', takeId: take.id, t } });
  }
  return { ref, media };
}

// Pure: what the image prompt writer needs to know about the film.
function buildImageContext(project, segment, refsUsed = []) {
  const lines = ['FILM CONTEXT — this still is authored for a film that is generated shot by shot with a video model; it must look like a frame of that film.'];
  if (project.logline?.trim()) lines.push(`Logline: ${project.logline.trim()}`);
  const beats = (project.script ?? []).filter(b => b.beat?.trim());
  if (beats.length) { lines.push('Story so far:'); beats.forEach((b, i) => lines.push(`  ${i + 1}. ${b.beat.trim()}`)); }
  if (segment) {
    lines.push(`Purpose: the first frame of segment ${segment.index + 1}${segment.intent?.trim() ? ` — in that shot: ${segment.intent.trim()}` : ''}. Compose it so motion can start from it (a still moment, not mid-action blur).`);
  } else {
    lines.push('Purpose: a reference image for the bank (a character, place, prop or style that later shots must stay consistent with).');
  }
  if (refsUsed.length) {
    lines.push('Keep these consistent with the reference bank (images are attached):');
    for (const ref of refsUsed) lines.push(`  ${ref.name} (${ref.kind})${ref.description ? `: ${ref.description}` : ''}`);
  }
  return lines.join('\n');
}

// Writes an image prompt in the image arch's own language from the user's
// description — the Generate step's prompt writer (arch guidance + the
// model's skill and notes) plus the film context and the segment's selected
// reference images as vision input.
async function writeImagePrompt({ project, cfg, modelConfig, intent, steering = '', segmentId = null, onToken, signal }) {
  const text = (intent ?? '').trim();
  if (!text) throw httpError('describe the image first');
  if (cfg.promptRefinement === false) return text;
  const arch = modelConfig.architecture;
  const segment = segmentId ? projects.findSegment(project, segmentId) : null;
  const refsUsed = segment ? segment.refIds.map(id => project.refs.find(r => r.id === id)).filter(Boolean) : [];
  const skillSummary = cfg.skillRefinement !== false ? skills.getSummary(modelConfig.id ?? '', arch) : null;
  const context = [combineContext(skillSummary, buildNotesSummary(modelConfig.notes)), buildImageContext(project, segment, refsUsed)].filter(Boolean).join('\n\n');
  const messages = buildInitialMessages(text, arch, getDefaults(arch), context);
  if (steering?.trim()) {
    messages[messages.length - 1].content += `\n\nDirector's notes — the prompt must follow these (framing, lighting, mood), phrased in this model's prompt format:\n${steering.trim()}`;
  }
  if (cfg.llmExtras !== false) {
    const images = refsUsed.flatMap(r => r.media.filter(m => m.type === 'image').slice(0, 2).map(m => ({ label: `${r.name} (${r.kind})`, b64: readBase64(project, m.file) }))).filter(v => v.b64);
    if (images.length) {
      messages.splice(1, 0, { role: 'user', content: `Reference images to stay consistent with, in order: ${images.map((v, i) => `${i + 1}. ${v.label}`).join('; ')}.`, images: images.map(v => v.b64) });
    }
  }
  return refineVideoPrompt(cfg, messages, onToken, signal, text);
}

// Generate a still with any image model straight into the bank (and optionally
// as a segment's start frame). Raw model settings + arch defaults, no workflow:
// this is how a scene gets authored with e.g. anima before H3 animates it.
async function generateImage({ project, cfg, modelId, prompt, intent = '', negativePrompt, width, height, steps, cfgScale, seed, refId, newRef, segmentId, emit = () => {}, signal, isKilled = () => false }) {
  const modelConfig = cfg?.models?.[modelId];
  if (!modelConfig) throw httpError(`Model "${modelId}" not found in config`);
  const arch = modelConfig.architecture;
  if (archMeta[arch]?.videoArch) throw httpError(`"${modelConfig.label ?? modelId}" is a video model — pick an image model to generate a still`);
  const text = (prompt ?? '').trim();
  if (!text) throw httpError('prompt required');
  const segment = segmentId ? projects.findSegment(project, segmentId) : null;

  // Default size: the arch's pixel budget in the film's aspect ratio, so the
  // still already matches the shot (H3 rescales, but the ratio should agree).
  const d = getDefaults(arch);
  const fmt = project.format ?? { width: d.width, height: d.height };
  const fitted = fitToBudget(fmt.width, fmt.height, d.width, d.height, 64, Math.max(d.width, d.height)) ?? { width: d.width, height: d.height };
  const usedSeed = videoTake.pickSeed({ seed });
  const params = {
    ...d,
    width:  Number(width)  || fitted.width,
    height: Number(height) || fitted.height,
    ...(steps    != null && steps    !== '' ? { steps:    Number(steps) }    : {}),
    ...(cfgScale != null && cfgScale !== '' ? { cfgScale: Number(cfgScale) } : {}),
    seed: usedSeed,
    positivePrompt: text,
    negativePrompt: negativePrompt != null && negativePrompt !== '' ? String(negativePrompt) : (d.negativePrompt ?? ''),
  };
  const { workflow } = buildWorkflow(modelConfig, params);

  emit('phase', { phase: 'generating' });
  const { images } = await comfyui.generate(workflow, pct => emit('progress', { pct }), url => emit('preview', { url }), { signal });
  if (isKilled()) throw new Error('Generation stopped by user');
  if (!images?.length) throw new Error('ComfyUI returned no image output');

  const ref = refId ? projects.findRef(project, refId)
    : projects.addRef(project, newRef?.name ? newRef : { kind: 'scene', name: text.slice(0, 48), description: newRef?.description ?? '' });
  const rel = `refs/${ref.id}-${Date.now().toString(36)}${shortId().slice(0, 4)}.png`;
  await comfyui.downloadOutput(images[0], projects.mediaPath(project.id, rel), { signal });
  const media = projects.addRefMedia(project, ref.id, {
    type: 'image', file: rel,
    source: { type: 'generate', modelId, prompt: text, ...(intent?.trim() ? { intent: intent.trim() } : {}), seed: usedSeed, width: params.width, height: params.height },
  });
  if (segment) {
    projects.updateSegment(project, segment.id, { start: { ...segment.start, mode: 'continue', startImage: { refId: ref.id, mediaId: media.id } } });
  }
  emit('image', { url: projects.mediaUrl(project.id, rel), refId: ref.id, mediaId: media.id });
  return { ref, media, segment, seed: usedSeed };
}

module.exports = { resolveInputs, buildFilmContext, buildAttemptsContext, writeFilmPrompt, runTake, approveTake, exportProject, captureFromTake, summarizeBeat, generateImage, writeImagePrompt, buildImageContext };

'use strict';

// Film projects API — a growing timeline of short video takes with a
// per-project reference bank. Independent of Generate sessions/workflows:
// a project pins a raw model entry and its own generation settings.

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const sharp   = require('sharp');
const config     = require('../services/config');
const comfyui    = require('../services/comfyui');
const ffmpeg     = require('../services/ffmpeg');
const projects   = require('../services/projects');
const filmRunner = require('../services/filmRunner');

const router = express.Router();

// projectId → { kill(), segmentId, takeId }
const activeFilmRuns = new Map();

function emit(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function sendError(res, err) {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[film]', err);
  res.status(status).json({ error: err.message });
}

function runningInfo(id) {
  const r = activeFilmRuns.get(id);
  return r ? { segmentId: r.segmentId, takeId: r.takeId, kind: r.kind ?? 'take' } : null;
}

// Loads the project or 404s; `mutating` refuses while a take is running.
function withProject(handler, { mutating = false } = {}) {
  return async (req, res) => {
    try {
      const project = projects.loadProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (mutating && activeFilmRuns.has(project.id)) return res.status(409).json({ error: 'A take is running — stop it first' });
      await handler(req, res, project);
    } catch (err) { sendError(res, err); }
  };
}

const AUDIO_EXTS = ['.wav', '.mp3', '.flac', '.ogg', '.m4a'];
function stamp() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function base64Buffer(data) {
  if (typeof data !== 'string' || !data) throw Object.assign(new Error('data (base64) required'), { status: 400 });
  return Buffer.from(data.includes(',') ? data.split(',')[1] : data, 'base64');
}

// Materialise a media spec into the project's refs/ folder → { type, file, source }.
async function storeMedia(project, ref, spec = {}) {
  const { type, source = {}, name = '', data } = spec;
  const dir = projects.mediaPath(project.id, 'refs');
  fs.mkdirSync(dir, { recursive: true });
  if (type === 'image') {
    let buffer;
    if (source.type === 'session') {
      if (!source.imageUrl) throw Object.assign(new Error('source.imageUrl required'), { status: 400 });
      const url = new URL(source.imageUrl, 'http://localhost');
      const filename  = url.searchParams.get('filename');
      if (!filename) throw Object.assign(new Error('imageUrl must be an /api/image URL'), { status: 400 });
      const subfolder = url.searchParams.get('subfolder') ?? '';
      const fileType  = url.searchParams.get('type') ?? 'output';
      const { comfyuiUrl } = config.load();
      const r = await fetch(`${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(fileType)}`);
      if (!r.ok) throw Object.assign(new Error(`Could not fetch the session image from ComfyUI (${r.status})`), { status: 502 });
      buffer = Buffer.from(await r.arrayBuffer());
    } else {
      buffer = base64Buffer(data);
    }
    const rel = `refs/${ref.id}-${stamp()}.png`;
    await sharp(buffer).png().toFile(projects.mediaPath(project.id, rel));
    return { type: 'image', file: rel, source: { type: source.type ?? 'upload', ...(source.sessionId ? { sessionId: source.sessionId } : {}), ...(source.imageUrl ? { imageUrl: source.imageUrl } : {}), ...(name ? { name } : {}) } };
  }
  if (type === 'audio') {
    const ext = path.extname(name ?? '').toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) throw Object.assign(new Error(`audio uploads must be one of ${AUDIO_EXTS.join(', ')}`), { status: 400 });
    const rel = `refs/${ref.id}-${stamp()}${ext}`;
    fs.writeFileSync(projects.mediaPath(project.id, rel), base64Buffer(data));
    return { type: 'audio', file: rel, source: { type: 'upload', name } };
  }
  throw Object.assign(new Error('media type must be image or audio'), { status: 400 });
}

// ── Projects ──────────────────────────────────────────────────────────────────

router.get('/', (req, res) => res.json({ projects: projects.listProjects() }));

router.get('/capabilities', async (req, res) => {
  res.json({ ffmpeg: await ffmpeg.detect({ refresh: true }) });
});

router.post('/', (req, res) => {
  try {
    const project = projects.newProject(req.body ?? {}, config.load());
    projects.saveProject(project);
    res.status(201).json(project);
  } catch (err) { sendError(res, err); }
});

router.get('/:id', withProject((req, res, project) => {
  res.json({ ...project, running: runningInfo(project.id) });
}));

router.put('/:id', withProject((req, res, project) => {
  projects.updateProject(project, req.body ?? {}, config.load());
  projects.saveProject(project);
  res.json(project);
}, { mutating: true }));

router.delete('/:id', withProject((req, res, project) => {
  projects.deleteProject(project.id);
  res.json({ ok: true });
}, { mutating: true }));

// ── Reference bank ────────────────────────────────────────────────────────────

router.post('/:id/refs', withProject(async (req, res, project) => {
  const { media = [], ...fields } = req.body ?? {};
  const ref = projects.addRef(project, fields);
  for (const spec of media) {
    const stored = await storeMedia(project, ref, spec);
    projects.addRefMedia(project, ref.id, stored);
  }
  projects.saveProject(project);
  res.status(201).json({ project, ref });
}));

router.put('/:id/refs/:rid', withProject((req, res, project) => {
  const ref = projects.updateRef(project, req.params.rid, req.body ?? {});
  projects.saveProject(project);
  res.json({ project, ref });
}));

router.delete('/:id/refs/:rid', withProject((req, res, project) => {
  projects.removeRef(project, req.params.rid);
  projects.saveProject(project);
  res.json({ project });
}, { mutating: true }));

router.post('/:id/refs/:rid/media', withProject(async (req, res, project) => {
  const ref = projects.findRef(project, req.params.rid);
  const stored = await storeMedia(project, ref, req.body ?? {});
  const media = projects.addRefMedia(project, ref.id, stored);
  projects.saveProject(project);
  res.status(201).json({ project, media });
}));

router.delete('/:id/refs/:rid/media/:mid', withProject((req, res, project) => {
  projects.removeRefMedia(project, req.params.rid, req.params.mid);
  projects.saveProject(project);
  res.json({ project });
}, { mutating: true }));

router.post('/:id/takes/:tid/capture', withProject(async (req, res, project) => {
  const { take } = projects.findTake(project, req.params.tid);
  const { refId, newRef, frame, audio } = req.body ?? {};
  await requireFfmpeg();
  const { ref, media } = await filmRunner.captureFromTake({ project, take, refId, newRef, frame, audio });
  projects.saveProject(project);
  res.status(201).json({ project, ref, media });
}));

// ── Segments ──────────────────────────────────────────────────────────────────

router.post('/:id/segments', withProject((req, res, project) => {
  const segment = projects.addSegment(project, req.body ?? {});
  projects.saveProject(project);
  res.status(201).json({ project, segment });
}, { mutating: true }));

router.put('/:id/segments/:sid', withProject((req, res, project) => {
  const segment = projects.updateSegment(project, req.params.sid, req.body ?? {});
  projects.saveProject(project);
  res.json({ project, segment });
}, { mutating: true }));

router.delete('/:id/segments/:sid', withProject((req, res, project) => {
  const seg = projects.removeSegment(project, req.params.sid);
  for (const t of seg.takes) for (const rel of [t.localFile, t.lastFrame]) {
    if (rel) { try { fs.unlinkSync(projects.mediaPath(project.id, rel)); } catch { /* gone */ } }
  }
  projects.saveProject(project);
  res.json({ project });
}, { mutating: true }));

async function requireFfmpeg() {
  const info = await ffmpeg.detect();
  if (!info.available) throw Object.assign(new Error(`${info.error ?? 'ffmpeg not found'} — the Film view needs ffmpeg on the server`), { status: 400 });
  if (!info.ffprobe) throw Object.assign(new Error(info.error), { status: 400 });
}

// Prompt preview: writes the segment's prompt with the LLM, no generation.
router.post('/:id/segments/:sid/prompt', withProject(async (req, res, project) => {
  const segment = projects.findSegment(project, req.params.sid);
  const cfg = config.load();
  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured — set one in Settings or write the prompt yourself' });
  const modelConfig = projects.filmModel(cfg, project.modelId);
  const body = req.body ?? {};
  if (body.intent !== undefined || body.steering !== undefined) {
    projects.updateSegment(project, segment.id, { intent: body.intent, steering: body.steering });
    projects.saveProject(project);
  }
  startSSE(res);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    const resolved = await filmRunner.resolveInputs({ project, segment, cfg, modelConfig, signal: abort.signal, upload: false });
    for (const w of resolved.warnings) emit(res, 'warning', { message: w });
    emit(res, 'phase', { phase: 'prompt_building' });
    const prompt = await filmRunner.writeFilmPrompt({
      project, segment, cfg, modelConfig, resolved, signal: abort.signal,
      onToken: token => emit(res, 'token', { token, phase: 'prompt' }),
    });
    // Persist the draft so it survives a reload; run uses it verbatim until cleared.
    projects.updateSegment(project, segment.id, { promptDraft: prompt });
    projects.saveProject(project);
    emit(res, 'prompt', { prompt });
    emit(res, 'done', { prompt });
  } catch (err) {
    if (err.name !== 'AbortError') emit(res, 'error', { message: err.message });
  }
  res.end();
}, { mutating: true }));

// Run one take. Body: { prompt?, seed?, intent?, steering? }.
router.post('/:id/segments/:sid/run', withProject(async (req, res, project) => {
  const segment = projects.findSegment(project, req.params.sid);
  const cfg = config.load();
  const body = req.body ?? {};
  // An explicit prompt wins; otherwise the segment's stored draft (written or edited earlier).
  const prompt = (body.prompt ?? segment.promptDraft ?? '').trim();
  await requireFfmpeg();
  projects.filmModel(cfg, project.modelId);
  if (!prompt && !cfg.llmModel && cfg.promptRefinement !== false) {
    return res.status(400).json({ error: 'No LLM model configured — write the prompt yourself or set one in Settings' });
  }
  const patch = {};
  for (const k of ['intent', 'steering', 'seed', 'frames', 'refIds', 'start', 'loras']) if (body[k] !== undefined) patch[k] = body[k];
  if (body.prompt !== undefined && prompt !== (segment.promptDraft ?? '')) patch.promptDraft = prompt;
  if (Object.keys(patch).length) projects.updateSegment(project, segment.id, patch);
  // Validate the start source before streaming so a plain 400 reaches the client.
  await filmRunner.resolveInputs({ project, segment, cfg, modelConfig: cfg.models[project.modelId], upload: false });

  startSSE(res);
  const abort = new AbortController();
  let killed = false;
  const run = {
    segmentId: segment.id, takeId: null,
    kill: async () => { killed = true; abort.abort(); await comfyui.interrupt(); },
  };
  activeFilmRuns.set(project.id, run);
  const tag = project.id.slice(0, 8);
  try {
    const take = await filmRunner.runTake({
      project, segment, cfg, prompt: prompt || null, seed: body.seed ?? null,
      signal: abort.signal, isKilled: () => killed,
      emit: (event, data) => {
        if (event === 'take_start') run.takeId = data.takeId;
        emit(res, event, { projectId: project.id, segmentId: segment.id, ...data });
      },
    });
    emit(res, 'done', { projectId: project.id, segmentId: segment.id, take });
  } catch (err) {
    if (killed || err.message === 'Stopped' || err.name === 'AbortError') {
      console.log(`[${tag}] take stopped by user`);
      emit(res, 'stopped', { projectId: project.id, segmentId: segment.id });
    } else {
      console.error(`[${tag}] take failed:`, err);
      emit(res, 'error', { projectId: project.id, segmentId: segment.id, message: err.message });
    }
  } finally {
    activeFilmRuns.delete(project.id);
    res.end();
  }
}));

// Image prompt writer: the user's description → a prompt in the image arch's
// language. Body: { modelId, intent, steering?, segmentId? }. SSE: phase, token, prompt, done.
router.post('/:id/images/prompt', withProject(async (req, res, project) => {
  const cfg  = config.load();
  const body = req.body ?? {};
  const modelConfig = cfg.models?.[body.modelId];
  if (!modelConfig) return res.status(400).json({ error: `Model "${body.modelId}" not found in config` });
  if (!(body.intent ?? '').trim()) return res.status(400).json({ error: 'describe the image first' });
  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured — set one in Settings or write the prompt yourself' });
  if (body.segmentId) projects.findSegment(project, body.segmentId);
  startSSE(res);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  try {
    emit(res, 'phase', { phase: 'prompt_building' });
    const prompt = await filmRunner.writeImagePrompt({
      project, cfg, modelConfig, intent: body.intent, steering: body.steering, segmentId: body.segmentId ?? null,
      signal: abort.signal, onToken: token => emit(res, 'token', { token, phase: 'prompt' }),
    });
    emit(res, 'prompt', { prompt });
    emit(res, 'done', { prompt });
  } catch (err) {
    if (err.name !== 'AbortError') emit(res, 'error', { message: err.message });
  }
  res.end();
}, { mutating: true }));

// Generate a still with an image model into the bank (optionally as a
// segment's start frame). Body: { modelId, prompt, negativePrompt?, width?,
// height?, steps?, cfgScale?, seed?, refId? | newRef?, segmentId? }.
router.post('/:id/images/generate', withProject(async (req, res, project) => {
  const cfg  = config.load();
  const body = req.body ?? {};
  if (!cfg.models?.[body.modelId]) return res.status(400).json({ error: `Model "${body.modelId}" not found in config` });
  if (!(body.prompt ?? '').trim()) return res.status(400).json({ error: 'prompt required' });
  if (body.segmentId) projects.findSegment(project, body.segmentId);

  startSSE(res);
  const abort = new AbortController();
  let killed = false;
  const run = { segmentId: body.segmentId ?? null, takeId: null, kind: 'image', kill: async () => { killed = true; abort.abort(); await comfyui.interrupt(); } };
  activeFilmRuns.set(project.id, run);
  const tag = project.id.slice(0, 8);
  try {
    emit(res, 'image_start', { projectId: project.id, segmentId: body.segmentId ?? null, modelId: body.modelId });
    const { ref, media, seed } = await filmRunner.generateImage({
      project, cfg, ...body, signal: abort.signal, isKilled: () => killed,
      emit: (event, data) => emit(res, event, { projectId: project.id, ...data }),
    });
    projects.saveProject(project);
    emit(res, 'done', { projectId: project.id, project, ref, media, seed });
  } catch (err) {
    if (killed || err.message === 'Stopped' || err.name === 'AbortError') {
      console.log(`[${tag}] image generation stopped by user`);
      emit(res, 'stopped', { projectId: project.id });
    } else {
      console.error(`[${tag}] image generation failed:`, err);
      emit(res, 'error', { projectId: project.id, message: err.message });
    }
  } finally {
    activeFilmRuns.delete(project.id);
    res.end();
  }
}, { mutating: true }));

router.post('/:id/kill', (req, res) => {
  const run = activeFilmRuns.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'No take is running for this project' });
  run.kill().then(() => res.json({ ok: true })).catch(err => sendError(res, err));
});

router.post('/:id/segments/:sid/takes/:tid/verdict', withProject(async (req, res, project) => {
  const segment = projects.findSegment(project, req.params.sid);
  const take = segment.takes.find(t => t.id === req.params.tid);
  if (!take) return res.status(404).json({ error: 'Take not found' });
  const { verdict, note = '' } = req.body ?? {};
  if (verdict === 'approved') {
    const { staled, beat, warning, nextSegment } = await filmRunner.approveTake({ project, segment, take, cfg: config.load(), note });
    projects.saveProject(project);
    return res.json({ project, staled, beat, nextSegment, ...(warning ? { warning } : {}) });
  }
  projects.setVerdict(project, segment.id, take.id, verdict, note);
  projects.saveProject(project);
  res.json({ project, staled: [], beat: null });
}, { mutating: true }));

router.post('/:id/export', withProject(async (req, res, project) => {
  await requireFfmpeg();
  const result = await filmRunner.exportProject({ project });
  res.json(result);
}, { mutating: true }));

// Local media (clips, last frames, reference files, export). sendFile handles
// Range requests, which <video> seeking needs.
router.use('/:id/media', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
  let abs;
  try {
    const rel = decodeURIComponent(req.path.replace(/^\/+/, ''));
    abs = projects.mediaPath(req.params.id, rel);
  } catch { return res.status(400).json({ error: 'invalid media path' }); }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'not found' });
  res.sendFile(abs, { dotfiles: 'deny' });
});

// Boot recovery: segments left 'running' by a dead process.
function recoverProjects() {
  for (const summary of projects.listProjects(Infinity)) {
    const p = projects.loadProject(summary.id);
    if (p && projects.resetRunning(p)) {
      projects.saveProject(p, { touch: false });
      console.warn(`[startup] film project ${p.id.slice(0, 8)} had a take running at shutdown — reset to draft`);
    }
  }
}

module.exports = router;
module.exports.recoverProjects = recoverProjects;
module.exports.activeFilmRuns  = activeFilmRuns;

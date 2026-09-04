import { reactive } from 'vue';
import { api } from '../api.js';
import { readSSEStream } from './generate.js';

// Film: a project is a growing timeline of ~5 s video segments, each built from
// takes the user approves one at a time. Independent of Generate sessions and
// workflows — a project pins a raw video model and its own generation settings.

export const filmState = reactive({
  ffmpeg:    null,      // null = unknown; { available, version, path, error } once loaded
  projects:  [],
  project:   null,      // full project doc
  segmentId: null,      // selected segment id

  // one take at a time per project
  running:       false,
  runSegmentId:  null,
  runTakeId:     null,
  phase:         '',
  status:        '',
  progress:      0,
  previewUrl:    null,

  // prompt preview (segment-local, sent as `prompt` on run when non-empty)
  streamingPrompt: '',
  promptDraft:     '',
  promptFor:       null,
  promptStreaming: false,

  exportUrl:   null,
  exportInfo:  null,

  // What the preview pane shows: the selected take, or an image (reference
  // media, a start frame, a generated still), or nothing.
  preview:     { type: 'none', url: null, caption: '', takeId: null, refId: null, mediaId: null },
  // Timeline playback: approved takes back to back in the preview. null when not playing.
  playlist:    null,   // { items: [{ segmentId, takeId, url, index }], pos }
  previewTime: 0,      // current playback time of the preview player (capture tools read it)
});

const PHASE_LABELS = { prompt_building: 'Building prompt…', generating: 'Generating…', saving: 'Saving take…' };

// ── helpers ─────────────────────────────────────────────────────────────────

export function mediaUrl(file, projectId = filmState.project?.id) {
  if (!file || !projectId) return null;
  if (file.startsWith('/')) return file;
  return `/api/projects/${encodeURIComponent(projectId)}/media/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export function currentSegment() {
  return filmState.project?.segments?.find(s => s.id === filmState.segmentId) ?? null;
}

// Nearest earlier segment with an approved take → { segment, take } | null
export function previousApprovedTake(segment, project = filmState.project) {
  if (!project || !segment) return null;
  for (let i = segment.index - 1; i >= 0; i--) {
    const s = project.segments[i];
    const t = s?.takes?.find(t => t.id === s.approvedTakeId);
    if (t) return { segment: s, take: t };
  }
  return null;
}

export function findTake(takeId, project = filmState.project) {
  for (const s of project?.segments ?? []) {
    const t = s.takes?.find(t => t.id === takeId);
    if (t) return { segment: s, take: t };
  }
  return null;
}

export function findRef(refId, project = filmState.project) {
  return project?.refs?.find(r => r.id === refId) ?? null;
}

// Adapter so IterationCard can render a take.
export function takeToIteration(take, n) {
  return {
    n,
    videoUrl:  take.videoUrl ?? mediaUrl(take.localFile),
    imageUrl:  null,
    verdict:   { approved: 'ACCEPT', rejected: 'REJECT' }[take.verdict] ?? null,
    status:    '',
    progress:  100,
    seed:      take.seed,
    prompt:    take.prompt,
    warnings:  take.warnings ?? [],
    takeId:    take.id,
  };
}

function setProject(project) {
  if (!project) return;
  const { running, ...doc } = project;
  filmState.project = doc;
  if (running && !filmState.running) {
    // A take is running on the server (started before a refresh) — reflect it,
    // though v1 cannot re-attach to its stream.
    filmState.running      = true;
    filmState.runSegmentId = running.segmentId;
    filmState.runTakeId    = running.takeId;
    filmState.status       = 'A take is running on the server (started before this page loaded)';
  }
  // Keep the selection valid
  if (!doc.segments?.some(s => s.id === filmState.segmentId)) {
    filmState.segmentId = doc.segments?.[0]?.id ?? null;
  }
}

function selectDefaultSegment() {
  const segs = filmState.project?.segments ?? [];
  const first = segs.find(s => s.status !== 'approved') ?? segs[segs.length - 1];
  filmState.segmentId = first?.id ?? null;
  previewSegment(first ?? null);
}

// ── preview ──────────────────────────────────────────────────────────────────

export function setPreview(p, { keepPlaylist = false } = {}) {
  if (!keepPlaylist) filmState.playlist = null;
  filmState.preview = { type: 'none', url: null, caption: '', takeId: null, refId: null, mediaId: null, ...p };
  filmState.previewTime = 0;
}

// ── Timeline playback ────────────────────────────────────────────────────────

function approvedItems(project = filmState.project) {
  return (project?.segments ?? [])
    .filter(s => s.status === 'approved' && s.approvedTakeId)
    .map(s => { const t = s.takes.find(t => t.id === s.approvedTakeId); return t ? { segmentId: s.id, takeId: t.id, url: t.videoUrl ?? mediaUrl(t.localFile), index: s.index } : null; })
    .filter(Boolean);
}

export function timelineItemCount(project = filmState.project) { return approvedItems(project).length; }

function showPlaylistItem() {
  const pl = filmState.playlist;
  if (!pl) return;
  const item = pl.items[pl.pos];
  filmState.segmentId = item.segmentId;   // highlight the segment in the timeline; no preview reset
  setPreview({ type: 'take', url: item.url, caption: `▶ Timeline · segment ${item.index + 1} (${pl.pos + 1} of ${pl.items.length})`, takeId: item.takeId }, { keepPlaylist: true });
}

// Play every approved take in order, starting from `fromSegmentId` when given.
export function playTimeline(fromSegmentId = null) {
  const items = approvedItems();
  if (!items.length) { filmState.status = 'Nothing to play — approve a take first'; return; }
  let pos = fromSegmentId ? items.findIndex(i => i.segmentId === fromSegmentId) : 0;
  if (pos < 0) pos = 0;
  filmState.playlist = { items, pos };
  showPlaylistItem();
}

export function stopTimeline() {
  filmState.playlist = null;
}

// Called by the preview when the current clip ends → next clip, or stop at the end.
export function timelineEnded() {
  const pl = filmState.playlist;
  if (!pl) return;
  if (pl.pos + 1 >= pl.items.length) { filmState.playlist = null; filmState.status = 'Timeline finished'; return; }
  pl.pos += 1;
  showPlaylistItem();
}

export function timelineStep(delta) {
  const pl = filmState.playlist;
  if (!pl) return;
  const next = pl.pos + delta;
  if (next < 0 || next >= pl.items.length) return;
  pl.pos = next;
  showPlaylistItem();
}
export function previewTake(take, segment = null) {
  if (!take) return setPreview({});
  const seg = segment ?? findTake(take.id)?.segment;
  const n   = seg ? (seg.takes.findIndex(t => t.id === take.id) + 1) : null;
  const bits = [seg ? `Segment ${seg.index + 1}` : null, n ? `take ${n}` : null, take.startMode, take.verdict ?? 'undecided'].filter(Boolean);
  setPreview({ type: 'take', url: take.videoUrl ?? mediaUrl(take.localFile), caption: bits.join(' · '), takeId: take.id });
}
export function previewImage(url, caption = '', { refId = null, mediaId = null } = {}) {
  setPreview({ type: 'image', url, caption, refId, mediaId });
}
// Default preview for a segment: its approved take, else its newest take, else its start image.
export function previewSegment(segment) {
  if (!segment) return setPreview({});
  const approved = segment.takes?.find(t => t.id === segment.approvedTakeId);
  const newest   = segment.takes?.[segment.takes.length - 1];
  if (approved || newest) return previewTake(approved ?? newest, segment);
  const si = segment.start?.startImage;
  if (si) {
    const ref = findRef(si.refId);
    const media = ref?.media?.find(m => m.id === si.mediaId);
    if (media) return previewImage(mediaUrl(media.file), `Segment ${segment.index + 1} · start frame — ${ref.name}`, { refId: ref.id, mediaId: media.id });
  }
  const prev = previousApprovedTake(segment);
  if (prev?.take?.lastFrame && segment.start?.mode === 'continue') {
    return previewImage(mediaUrl(prev.take.lastFrame), `Segment ${segment.index + 1} · starts from the last frame of segment ${prev.segment.index + 1}`);
  }
  setPreview({});
}

// ── projects ─────────────────────────────────────────────────────────────────

export async function loadFfmpeg() {
  try {
    const caps = await api('GET', '/api/projects/capabilities');
    filmState.ffmpeg = caps.ffmpeg ?? { available: false, error: 'unknown' };
  } catch (err) {
    filmState.ffmpeg = { available: false, error: err.message };
  }
  return filmState.ffmpeg;
}

export async function loadProjects() {
  const res = await api('GET', '/api/projects');
  filmState.projects = res.projects ?? [];
  return filmState.projects;
}

export async function createProject({ title, modelId, logline = '' }) {
  const project = await api('POST', '/api/projects', { title, modelId, logline });
  await loadProjects();
  await openProject(project.id);
  return filmState.project;
}

export async function openProject(id) {
  const project = await api('GET', `/api/projects/${encodeURIComponent(id)}`);
  filmState.running = false; filmState.runSegmentId = null; filmState.runTakeId = null;
  filmState.status = ''; filmState.progress = 0; filmState.previewUrl = null;
  filmState.streamingPrompt = ''; filmState.promptDraft = ''; filmState.promptFor = null;
  filmState.exportUrl = null; filmState.exportInfo = null;
  filmState.segmentId = null;
  setProject(project);
  selectDefaultSegment();
  return filmState.project;
}

export async function reloadProject() {
  if (!filmState.project) return null;
  const project = await api('GET', `/api/projects/${encodeURIComponent(filmState.project.id)}`);
  setProject(project);
  return filmState.project;
}

export function closeProject() {
  filmState.project = null;
  filmState.segmentId = null;
  setPreview({});
}

export async function updateProject(patch) {
  const project = await api('PUT', `/api/projects/${encodeURIComponent(filmState.project.id)}`, patch);
  setProject(project);
  await loadProjects().catch(() => {});
  return filmState.project;
}

export async function deleteProject(id) {
  await api('DELETE', `/api/projects/${encodeURIComponent(id)}`);
  if (filmState.project?.id === id) closeProject();
  await loadProjects();
}

// ── segments ─────────────────────────────────────────────────────────────────

const pid = () => encodeURIComponent(filmState.project.id);

export async function addSegment() {
  const { project, segment } = await api('POST', `/api/projects/${pid()}/segments`, {});
  setProject(project);
  selectSegment(segment.id);
  return segment;
}

export function selectSegment(id) {
  const seg = filmState.project?.segments?.find(s => s.id === id) ?? null;
  if (filmState.promptFor !== id) {
    // The draft lives on the segment (server-side) so it survives reloads.
    filmState.streamingPrompt = '';
    filmState.promptDraft = seg?.promptDraft ?? '';
    filmState.promptFor = seg ? id : null;
  }
  filmState.segmentId = id;
  previewSegment(seg);
}

// Persist prompt edits on the segment (debounced) so they survive a reload.
let draftTimer = null;
export function setPromptDraft(sid, text) {
  filmState.promptFor   = sid;
  filmState.promptDraft = text;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    saveSegment(sid, { promptDraft: text }).catch(err => { filmState.status = `Draft not saved: ${err.message}`; });
  }, 600);
}

export async function saveSegment(sid, patch) {
  const { project, segment } = await api('PUT', `/api/projects/${pid()}/segments/${encodeURIComponent(sid)}`, patch);
  setProject(project);
  return segment;
}

export async function deleteSegment(sid) {
  const { project } = await api('DELETE', `/api/projects/${pid()}/segments/${encodeURIComponent(sid)}`);
  setProject(project);
  selectDefaultSegment();
}

// ── references ───────────────────────────────────────────────────────────────

export function readFilesAsDataUrls(files) {
  return Promise.all(Array.from(files).map(file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve({ name: file.name, data: reader.result });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  })));
}

function mediaSpecFromFile({ name, data }) {
  const isAudio = /^data:audio\//.test(data) || /\.(wav|mp3|flac|ogg|m4a)$/i.test(name);
  return { type: isAudio ? 'audio' : 'image', source: { type: 'upload' }, name, data };
}

// target: { refId } to append to an entry, or { kind, name, description } to create one
export async function addRefMedia(target, specs) {
  if (target.refId) {
    let last = null;
    for (const spec of specs) {
      last = await api('POST', `/api/projects/${pid()}/refs/${encodeURIComponent(target.refId)}/media`, spec);
      setProject(last.project);
    }
    return findRef(target.refId);
  }
  const { project, ref } = await api('POST', `/api/projects/${pid()}/refs`, {
    kind: target.kind, name: target.name, description: target.description ?? '', pinned: !!target.pinned, media: specs,
  });
  setProject(project);
  return ref;
}

export async function uploadRefFiles(files, target) {
  const encoded = await readFilesAsDataUrls(files);
  return addRefMedia(target, encoded.map(mediaSpecFromFile));
}

export async function addRefFromSession({ sessionId, imageUrl }, target) {
  return addRefMedia(target, [{ type: 'image', source: { type: 'session', imageUrl, sessionId } }]);
}

export async function createRef({ kind, name, description = '', pinned = false }) {
  const { project, ref } = await api('POST', `/api/projects/${pid()}/refs`, { kind, name, description, pinned });
  setProject(project);
  return ref;
}

export async function updateRef(rid, patch) {
  const { project, ref } = await api('PUT', `/api/projects/${pid()}/refs/${encodeURIComponent(rid)}`, patch);
  setProject(project);
  return ref;
}

export async function removeRef(rid) {
  const { project } = await api('DELETE', `/api/projects/${pid()}/refs/${encodeURIComponent(rid)}`);
  setProject(project);
}

export async function removeRefMedia(rid, mid) {
  const { project } = await api('DELETE', `/api/projects/${pid()}/refs/${encodeURIComponent(rid)}/media/${encodeURIComponent(mid)}`);
  setProject(project);
}

// body: { frame: t } | { audio: [a, b] }; target: { refId } | { newRef: { kind, name, description } }
export async function captureFromTake(takeId, body, target) {
  const payload = { ...body, ...(target.refId ? { refId: target.refId } : { newRef: target.newRef }) };
  const res = await api('POST', `/api/projects/${pid()}/takes/${encodeURIComponent(takeId)}/capture`, payload);
  setProject(res.project);
  return res;
}

// ── prompt / run / verdict / export ──────────────────────────────────────────

function handleFilmEvent(event, data) {
  switch (event) {
    case 'take_start':
      filmState.runSegmentId = data.segmentId ?? filmState.runSegmentId;
      filmState.runTakeId    = data.takeId ?? null;
      filmState.progress     = 0;
      filmState.previewUrl   = null;
      break;
    case 'phase':
      filmState.phase  = data.phase;
      filmState.status = PHASE_LABELS[data.phase] ?? data.phase;
      if (data.phase === 'prompt_building') { filmState.streamingPrompt = ''; filmState.promptStreaming = true; }
      else filmState.promptStreaming = false;
      break;
    case 'token':
      filmState.streamingPrompt += data.token;
      break;
    case 'prompt':
      filmState.promptDraft     = data.prompt;
      filmState.promptFor       = filmState.runSegmentId ?? filmState.segmentId;
      filmState.streamingPrompt = '';
      filmState.promptStreaming = false;
      break;
    case 'progress':
      filmState.progress = data.pct ?? 0;
      filmState.status   = `Generating… ${filmState.progress}%`;
      break;
    case 'preview':
      filmState.previewUrl = data.url;
      break;
    case 'warning':
      filmState.status = `Warning: ${data.message}`;
      break;
    case 'video':
      filmState.status = 'Video ready';
      break;
    case 'image_start':
      filmState.progress = 0; filmState.previewUrl = null;
      filmState.status = 'Generating image…';
      break;
    case 'image':
      filmState.status = 'Image ready';
      lastImage = data;
      break;
    case 'take_complete':
      filmState.status = 'Take complete';
      if (data.take && (data.segmentId ?? filmState.runSegmentId) === filmState.segmentId) previewTake(data.take);
      break;
    case 'done':
      if (data.project) setProject(data.project);
      filmState.status = filmState.status || 'Done';
      break;
    case 'stopped':
      filmState.status = 'Stopped';
      break;
    case 'error':
      filmState.status = `Error: ${data.message}`;
      break;
  }
}

let lastImage = null;

// Image prompt writer (POST /images/prompt): streams tokens to onToken, resolves the prompt text.
export async function writeImagePrompt(body, onToken) {
  const response = await fetch(`/api/projects/${pid()}/images/prompt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const e = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(e.error || response.statusText);
  }
  let prompt = null, error = null;
  await new Promise(resolve => readSSEStream(response, resolve, (event, data) => {
    if (event === 'token') onToken?.(data.token);
    else if (event === 'prompt' || event === 'done') prompt = data.prompt ?? prompt;
    else if (event === 'error') error = data.message;
  }));
  if (error) throw new Error(error);
  return prompt;
}

// Generate a still with an image model into the bank; body per
// POST /api/projects/:id/images/generate. Resolves { url, ref, media, seed } or null when stopped.
export async function generateImage(body) {
  if (filmState.running) throw new Error('Another job is running');
  lastImage = null;
  let done = null;
  filmState.running      = true;
  filmState.runSegmentId = body.segmentId ?? null;
  filmState.runTakeId    = null;
  filmState.progress     = 0;
  filmState.previewUrl   = null;
  filmState.status       = 'Starting image…';
  const onEvent = (event, data) => {
    if (event === 'done') done = data;
    handleFilmEvent(event, data);
  };
  try {
    const response = await fetch(`/api/projects/${pid()}/images/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) {
      const e = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(e.error || response.statusText);
    }
    await new Promise(resolve => readSSEStream(response, resolve, onEvent));
    if (!done) {
      if (!filmState.status.startsWith('Error') && !filmState.status.startsWith('Stopped')) filmState.status = 'Image generation ended without a result';
      if (filmState.status.startsWith('Error')) throw new Error(filmState.status.replace(/^Error: /, ''));
      return null;
    }
    filmState.status = `Image saved to "${done.ref?.name ?? 'bank'}"`;
    const url = lastImage?.url ?? mediaUrl(done.media?.file);
    previewImage(url, `${done.ref?.name ?? 'Generated'} · seed ${done.seed}`, { refId: done.ref?.id ?? null, mediaId: done.media?.id ?? null });
    return { url, ref: done.ref, media: done.media, seed: done.seed };
  } finally {
    filmState.running      = false;
    filmState.runSegmentId = null;
    filmState.previewUrl   = null;
  }
}

async function streamPost(url, body, onDone) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    const e = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(e.error || response.statusText);
  }
  return new Promise(resolve => {
    readSSEStream(response, async () => { try { await onDone?.(); } finally { resolve(); } }, handleFilmEvent);
  });
}

export async function writePrompt(sid) {
  filmState.promptFor       = sid;
  filmState.promptDraft     = '';
  filmState.streamingPrompt = '';
  filmState.promptStreaming = true;
  filmState.runSegmentId    = sid;
  filmState.status          = 'Building prompt…';
  try {
    await streamPost(`/api/projects/${pid()}/segments/${encodeURIComponent(sid)}/prompt`, {}, () => {
      filmState.promptStreaming = false;
      filmState.runSegmentId = null;
      if (!filmState.status.startsWith('Error')) filmState.status = 'Prompt ready — edit it or run';
    });
  } catch (err) {
    filmState.promptStreaming = false;
    filmState.runSegmentId = null;
    filmState.status = `Error: ${err.message}`;
    throw err;
  }
}

export async function runSegment(sid, { seed = null } = {}) {
  if (filmState.running) return;
  const body = {};
  if (filmState.promptDraft.trim() && filmState.promptFor === sid) body.prompt = filmState.promptDraft.trim();
  if (seed != null && seed !== '') body.seed = Number(seed);

  filmState.running      = true;
  filmState.runSegmentId = sid;
  filmState.runTakeId    = null;
  filmState.progress     = 0;
  filmState.previewUrl   = null;
  filmState.status       = 'Starting take…';
  try {
    await streamPost(`/api/projects/${pid()}/segments/${encodeURIComponent(sid)}/run`, body, async () => {
      filmState.running      = false;
      filmState.runSegmentId = null;
      filmState.runTakeId    = null;
      filmState.previewUrl   = null;
      await reloadProject().catch(() => {});
    });
  } catch (err) {
    filmState.running = false;
    filmState.runSegmentId = null;
    filmState.status = `Error: ${err.message}`;
    throw err;
  }
}

export async function killRun() {
  if (!filmState.project) return;
  try { await api('POST', `/api/projects/${pid()}/kill`); }
  catch (err) { filmState.status = `Stop failed: ${err.message}`; }
}

export async function setVerdict(sid, tid, verdict, note = '') {
  const res = await api('POST', `/api/projects/${pid()}/segments/${encodeURIComponent(sid)}/takes/${encodeURIComponent(tid)}/verdict`, { verdict, note });
  setProject(res.project);
  { const found = findTake(tid); if (found && filmState.preview.takeId === tid) previewTake(found.take, found.segment); }
  if (verdict === 'approved') {
    // Approve advances: select the next non-approved segment (the server appends one when none follows)
    const segs = filmState.project.segments;
    const idx  = segs.findIndex(s => s.id === sid);
    const next = segs.slice(idx + 1).find(s => s.status !== 'approved') ?? segs[idx];
    selectSegment(next.id);
    filmState.status = res.warning ? `Approved (${res.warning})` : (res.beat ? `Approved — "${res.beat}"` : 'Approved');
  } else {
    filmState.status = 'Rejected';
  }
  return res;
}

export async function exportProject() {
  filmState.status = 'Exporting…';
  const res = await api('POST', `/api/projects/${pid()}/export`);
  filmState.exportUrl  = res.url;
  filmState.exportInfo = res;
  setPreview({ type: 'take', url: `${res.url}?v=${Date.now()}`, caption: `Export · ${res.clips ?? ''} clip${res.clips === 1 ? '' : 's'}${res.durationSec ? ` · ${res.durationSec.toFixed(1)} s` : ''}`, takeId: null });
  filmState.status = `Exported ${res.clips ?? ''} clip${res.clips === 1 ? '' : 's'}${res.durationSec ? ` · ${res.durationSec.toFixed(1)} s` : ''}`;
  return res;
}

'use strict';

// Film projects: persistence and entity operations. A project is a growing
// timeline of segments (each a short video take), a per-project reference
// bank, and the running script. It points at a raw model entry from
// cfg.models and carries its own generation settings — no workflow, no steps.
//
// Layout: <projectsDir>/<id>.json and <projectsDir>/<id>/{clips,refs,export}/
// for local media (takes are copied out of ComfyUI's output folder so a film
// never depends on it surviving).

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { archMeta, getDefaults } = require('../workflows');

const projectsDir = () =>
  process.env.PROJECTS_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '../../data'), 'projects');

const START_MODES = ['continue', 'cut', 'bridge'];
// 'scene' = a frame authored as a shot's start (or, later, bridge keyframe)
const REF_KINDS   = ['character', 'location', 'prop', 'style', 'voice', 'scene'];

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function shortId() { return uuidv4().replace(/-/g, '').slice(0, 12); }

// ── Paths ─────────────────────────────────────────────────────────────────────

function projectPath(id) { return path.join(projectsDir(), `${id}.json`); }
function projectDir(id)  { return path.join(projectsDir(), id); }

// Absolute path for a project-relative media file; refuses anything that
// resolves outside the project folder.
function mediaPath(id, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('invalid media path');
  const root = path.resolve(projectDir(id));
  const abs  = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('invalid media path');
  return abs;
}

function mediaUrl(id, rel) {
  return `/api/projects/${encodeURIComponent(id)}/media/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

// ── Model eligibility ─────────────────────────────────────────────────────────

function filmModel(cfg, modelId) {
  const model = cfg?.models?.[modelId];
  if (!model) throw Object.assign(new Error(`Model "${modelId}" not found in config`), { status: 400 });
  if (!archMeta[model.architecture]?.film) {
    const eligible = Object.keys(archMeta).filter(a => archMeta[a].film).join(', ');
    throw Object.assign(new Error(`Model "${model.label ?? modelId}" (${model.architecture}) cannot drive a Film project — supported: ${eligible}`), { status: 400 });
  }
  return model;
}

// Per-take generation settings. `null` means "the arch builder's default" — the
// sampler in particular stays unset so recipe-dependent defaults (ltxvideo's
// distilled vs full sampler) still apply. `filmFrames` is the arch's ~5 s take.
function defaultGen(arch) {
  const d = getDefaults(arch);
  return { frames: archMeta[arch]?.filmFrames ?? d.frames ?? 124, steps: null, sampler: null, refImageSize: 'match' };
}

function defaultFormat(arch) {
  const d = getDefaults(arch);
  return { width: d.width, height: d.height, fps: d.fps };
}

// ── Project CRUD ──────────────────────────────────────────────────────────────

function newProject({ title, modelId, logline = '' }, cfg) {
  const model = filmModel(cfg, modelId);
  const now = new Date().toISOString();
  return {
    id: uuidv4(), title: (title ?? '').trim() || 'Untitled film', createdAt: now, updatedAt: now,
    modelId, logline: String(logline ?? ''),
    format: defaultFormat(model.architecture),
    gen:    defaultGen(model.architecture),
    refs: [], segments: [], script: [],
  };
}

function hasTakes(p) { return p.segments.some(s => s.takes.length > 0); }
// The model is locked once a take is approved (the film is built on it); the
// format can always change — clips keep their own size and export re-encodes
// when sizes differ — so a project can be reframed while it is still being found.
function hasApproved(p) { return p.segments.some(s => s.status === 'approved' && s.approvedTakeId); }

function updateProject(p, patch, cfg) {
  if (patch.title !== undefined)   p.title   = String(patch.title).trim() || p.title;
  if (patch.logline !== undefined) p.logline = String(patch.logline ?? '');
  if (patch.gen && typeof patch.gen === 'object') {
    for (const k of ['frames', 'steps', 'sampler', 'refImageSize']) {
      if (patch.gen[k] !== undefined) p.gen[k] = patch.gen[k] === '' ? null : patch.gen[k];
    }
    if (p.gen.frames != null) p.gen.frames = Math.max(5, Math.round(Number(p.gen.frames)) || 124);
  }
  const locked = hasApproved(p);
  if (patch.modelId !== undefined && patch.modelId !== p.modelId) {
    if (locked) throw Object.assign(new Error('The model cannot change once a take is approved — the film is built on it'), { status: 409 });
    const model = filmModel(cfg, patch.modelId);
    p.modelId = patch.modelId;
    p.format  = defaultFormat(model.architecture);
    p.gen     = defaultGen(model.architecture);
  }
  if (patch.format && typeof patch.format === 'object') {
    const next = { ...p.format };
    for (const k of ['width', 'height', 'fps']) if (patch.format[k] !== undefined) next[k] = Number(patch.format[k]);
    if (JSON.stringify(next) !== JSON.stringify(p.format)) {
      const arch = cfg?.models?.[p.modelId]?.architecture;
      const mult = archMeta[arch]?.dimMultiple ?? 16;
      const snap = v => Math.max(mult, Math.round(v / mult) * mult);
      if (!(next.width > 0 && next.height > 0 && next.fps > 0)) throw Object.assign(new Error('format needs positive width, height and fps'), { status: 400 });
      p.format = { width: snap(next.width), height: snap(next.height), fps: Math.round(next.fps) };
    }
  }
  return p;
}

function saveProject(p, { touch = true } = {}) {
  ensureDir(projectsDir());
  if (touch) p.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectPath(p.id), JSON.stringify(p, null, 2));
  return p;
}

function loadProject(id) {
  try { return JSON.parse(fs.readFileSync(projectPath(id), 'utf8')); } catch { return null; }
}

function summarize(p) {
  return {
    id: p.id, title: p.title, modelId: p.modelId, updatedAt: p.updatedAt, createdAt: p.createdAt,
    segmentCount: p.segments.length,
    approvedCount: p.segments.filter(s => s.status === 'approved').length,
  };
}

function listProjects(limit = 200) {
  ensureDir(projectsDir());
  try {
    return fs.readdirSync(projectsDir())
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(projectsDir(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      .slice(0, limit)
      .map(summarize);
  } catch { return []; }
}

function deleteProject(id) {
  try { fs.unlinkSync(projectPath(id)); } catch { /* gone */ }
  try { fs.rmSync(projectDir(id), { recursive: true, force: true }); } catch { /* gone */ }
}

// ── Segments ──────────────────────────────────────────────────────────────────

function previousApprovedTake(p, index) {
  for (let i = index - 1; i >= 0; i--) {
    const seg = p.segments[i];
    const take = seg?.takes.find(t => t.id === seg.approvedTakeId);
    if (take) return { segment: seg, take };
  }
  return null;
}

// A new segment continues from the previous approved take when there is one.
// Otherwise it defaults to a cut (fresh shot from references) on archs that
// have reference-to-video; single-mode archs (LTX-2.3) always continue.
function addSegment(p, fields = {}, cfg = null) {
  const index = p.segments.length;
  const prev  = previousApprovedTake(p, index);
  const arch  = cfg?.models?.[p.modelId]?.architecture;
  const canCut = arch ? !!archMeta[arch]?.referenceToVideo : true;
  const seg = {
    id: shortId(), index, status: 'draft',
    start: { mode: prev || !canCut ? 'continue' : 'cut', startImage: null, includePrevTail: false },
    refIds: p.refs.filter(r => r.pinned).map(r => r.id),
    intent: '', steering: '', frames: p.gen.frames ?? 124, seed: null,
    loras: [],                       // [{ name, weight }] — per-segment LoRAs (scene / style / motion)
    promptDraft: '',                 // the written/edited prompt for the next take; used verbatim by run until cleared
    takes: [], approvedTakeId: null,
  };
  p.segments.push(seg);
  updateSegment(p, seg.id, fields);
  return seg;
}

function findSegment(p, sid) {
  const seg = p.segments.find(s => s.id === sid);
  if (!seg) throw Object.assign(new Error(`Segment "${sid}" not found`), { status: 404 });
  return seg;
}

function updateSegment(p, sid, patch = {}) {
  const seg = findSegment(p, sid);
  if (patch.intent   !== undefined) seg.intent   = String(patch.intent ?? '');
  if (patch.steering !== undefined) seg.steering = String(patch.steering ?? '');
  if (patch.promptDraft !== undefined) seg.promptDraft = String(patch.promptDraft ?? '');
  if (patch.frames   !== undefined) seg.frames   = patch.frames == null || patch.frames === '' ? (p.gen.frames ?? 124) : Math.max(5, Math.round(Number(patch.frames)) || 5);
  if (patch.seed     !== undefined) seg.seed     = patch.seed == null || patch.seed === '' ? null : Number(patch.seed);
  if (patch.loras    !== undefined) {
    if (!Array.isArray(patch.loras)) throw Object.assign(new Error('loras must be an array of { name, weight }'), { status: 400 });
    seg.loras = patch.loras
      .filter(l => l && typeof l.name === 'string' && l.name.trim())
      .map(l => ({ name: l.name.trim(), weight: Number.isFinite(Number(l.weight)) ? Number(l.weight) : 1.0 }));
  }
  if (patch.refIds   !== undefined) {
    if (!Array.isArray(patch.refIds)) throw Object.assign(new Error('refIds must be an array'), { status: 400 });
    const known = new Set(p.refs.map(r => r.id));
    seg.refIds = [...new Set(patch.refIds.filter(id => known.has(id)))];
  }
  if (patch.start !== undefined) {
    const start = { ...seg.start, ...(patch.start ?? {}) };
    if (!START_MODES.includes(start.mode)) throw Object.assign(new Error(`start.mode must be one of ${START_MODES.join(', ')}`), { status: 400 });
    if (start.startImage != null) {
      const { refId, mediaId } = start.startImage;
      const media = p.refs.find(r => r.id === refId)?.media.find(m => m.id === mediaId);
      if (!media || media.type !== 'image') throw Object.assign(new Error('start.startImage must name an image in the reference bank'), { status: 400 });
      start.startImage = { refId, mediaId };
    } else {
      start.startImage = null;
    }
    start.includePrevTail = !!start.includePrevTail;
    seg.start = start;
  }
  return seg;
}

// Only the last segment can go — earlier ones anchor what follows.
function removeSegment(p, sid) {
  const seg = findSegment(p, sid);
  if (seg.index !== p.segments.length - 1) throw Object.assign(new Error('Only the last segment can be deleted'), { status: 400 });
  p.segments.pop();
  p.script = p.script.filter(b => b.segmentId !== sid);
  return seg;
}

// ── Takes ─────────────────────────────────────────────────────────────────────

function addTake(p, sid, take) {
  const seg = findSegment(p, sid);
  seg.takes.push({ id: shortId(), createdAt: new Date().toISOString(), verdict: null, note: '', warnings: [], ...take });
  return seg.takes.at(-1);
}

function findTake(p, tid) {
  for (const seg of p.segments) {
    const take = seg.takes.find(t => t.id === tid);
    if (take) return { segment: seg, take };
  }
  throw Object.assign(new Error(`Take "${tid}" not found`), { status: 404 });
}

// approve: this take becomes the segment's output; every later segment that
// already has takes was built on a start frame that no longer applies → stale.
// reject: clears the approval when it was the approved take.
function setVerdict(p, sid, tid, verdict, note = '') {
  const seg  = findSegment(p, sid);
  const take = seg.takes.find(t => t.id === tid);
  if (!take) throw Object.assign(new Error(`Take "${tid}" not found in segment`), { status: 404 });
  if (!['approved', 'rejected'].includes(verdict)) throw Object.assign(new Error('verdict must be approved or rejected'), { status: 400 });
  take.verdict = verdict;
  take.note    = String(note ?? '');
  const staled = [];
  if (verdict === 'approved') {
    for (const t of seg.takes) if (t !== take && t.verdict === 'approved') t.verdict = null;
    const changed = seg.approvedTakeId !== take.id;
    seg.approvedTakeId = take.id;
    seg.status = 'approved';
    if (changed) {
      for (const later of p.segments.slice(seg.index + 1)) {
        if (later.takes.length && later.status !== 'stale') { later.status = 'stale'; staled.push(later.id); }
      }
    }
  } else if (seg.approvedTakeId === take.id) {
    seg.approvedTakeId = null;
    seg.status = 'draft';
  }
  return { staled };
}

function setBeat(p, sid, beat) {
  const entry = p.script.find(b => b.segmentId === sid);
  if (entry) entry.beat = beat; else p.script.push({ segmentId: sid, beat });
  // keep script in timeline order
  const order = new Map(p.segments.map((s, i) => [s.id, i]));
  p.script.sort((a, b) => (order.get(a.segmentId) ?? 1e9) - (order.get(b.segmentId) ?? 1e9));
}

// ── Reference bank ────────────────────────────────────────────────────────────

function addRef(p, { kind, name, description = '', pinned = false }) {
  if (!REF_KINDS.includes(kind)) throw Object.assign(new Error(`kind must be one of ${REF_KINDS.join(', ')}`), { status: 400 });
  const ref = { id: shortId(), kind, name: String(name ?? '').trim() || kind, description: String(description ?? ''), pinned: !!pinned, media: [] };
  p.refs.push(ref);
  return ref;
}

function findRef(p, rid) {
  const ref = p.refs.find(r => r.id === rid);
  if (!ref) throw Object.assign(new Error(`Reference "${rid}" not found`), { status: 404 });
  return ref;
}

function updateRef(p, rid, patch = {}) {
  const ref = findRef(p, rid);
  if (patch.kind !== undefined) {
    if (!REF_KINDS.includes(patch.kind)) throw Object.assign(new Error(`kind must be one of ${REF_KINDS.join(', ')}`), { status: 400 });
    ref.kind = patch.kind;
  }
  if (patch.name        !== undefined) ref.name        = String(patch.name).trim() || ref.name;
  if (patch.description !== undefined) ref.description = String(patch.description ?? '');
  if (patch.pinned      !== undefined) ref.pinned      = !!patch.pinned;
  return ref;
}

function removeRef(p, rid) {
  const ref = findRef(p, rid);
  p.refs = p.refs.filter(r => r !== ref);
  for (const seg of p.segments) {
    seg.refIds = seg.refIds.filter(id => id !== rid);
    if (seg.start?.startImage?.refId === rid) seg.start.startImage = null;
  }
  for (const m of ref.media) { try { fs.unlinkSync(mediaPath(p.id, m.file)); } catch { /* gone */ } }
  return ref;
}

function addRefMedia(p, rid, { type, file, source }) {
  const ref = findRef(p, rid);
  if (!['image', 'audio'].includes(type)) throw Object.assign(new Error('media type must be image or audio'), { status: 400 });
  const media = { id: shortId(), type, file, source: source ?? { type: 'upload' } };
  ref.media.push(media);
  return media;
}

function removeRefMedia(p, rid, mid) {
  const ref = findRef(p, rid);
  const media = ref.media.find(m => m.id === mid);
  if (!media) throw Object.assign(new Error(`Media "${mid}" not found`), { status: 404 });
  ref.media = ref.media.filter(m => m !== media);
  for (const seg of p.segments) {
    if (seg.start?.startImage?.mediaId === mid) seg.start.startImage = null;
  }
  try { fs.unlinkSync(mediaPath(p.id, media.file)); } catch { /* gone */ }
  return media;
}

// ── Boot recovery ─────────────────────────────────────────────────────────────

// A segment left 'running' belongs to a process that died mid-take.
function resetRunning(p) {
  let changed = false;
  for (const seg of p.segments) {
    if (seg.status === 'running') { seg.status = 'draft'; changed = true; }
  }
  return changed;
}

module.exports = {
  projectsDir, projectDir, projectPath, mediaPath, mediaUrl,
  START_MODES, REF_KINDS, filmModel,
  newProject, updateProject, saveProject, loadProject, listProjects, deleteProject, summarize, hasTakes, hasApproved,
  addSegment, findSegment, updateSegment, removeSegment, previousApprovedTake,
  addTake, findTake, setVerdict, setBeat,
  addRef, findRef, updateRef, removeRef, addRefMedia, removeRefMedia,
  resetRunning,
};

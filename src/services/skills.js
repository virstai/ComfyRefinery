'use strict';

const fs   = require('fs');
const path = require('path');

const skillsDir = () => process.env.SKILLS_DIR || path.join(__dirname, '../../data/skills');
function skillPath(workflowId) { return path.join(skillsDir(), `${workflowId}.json`); }
function ensureDir() { fs.mkdirSync(skillsDir(), { recursive: true }); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

const MAX_VERSIONS = 5;

// ── Migration ──────────────────────────────────────────────────────────────────

function migrate(data) {
  if (Array.isArray(data.versions)) return data;
  // Create a version if there is a skill text OR non-zero outcomes to preserve.
  const o = data.outcomes;
  const hasContent = data.skill || (o && (o.accepts + o.rejects) > 0);
  const versionId  = hasContent ? genId() : null;
  return {
    workflowId:      data.workflowId,
    workflowLabel:   data.workflowLabel,
    architecture:    data.architecture,
    skillLocked:     false,
    activeVersionId: versionId,
    versions: versionId ? [{
      id:        versionId,
      skill:     data.skill ?? null,
      createdAt: data.skillUpdatedAt ?? new Date().toISOString(),
      source:    'legacy',
      outcomes:  o ?? { accepts: 0, rejects: 0 },
    }] : [],
    notes: data.notes ?? [],
  };
}

function blankData(workflowId, workflowLabel, architecture) {
  return {
    workflowId, workflowLabel, architecture,
    skillLocked:     false,
    activeVersionId: null,
    versions:        [],
    notes:           [],
  };
}

function load(workflowId) {
  try { return migrate(JSON.parse(fs.readFileSync(skillPath(workflowId), 'utf8'))); }
  catch { return null; }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(skillPath(data.workflowId), JSON.stringify(data, null, 2));
}

function getActiveVersion(data) {
  return (data.versions ?? []).find(v => v.id === data.activeVersionId) ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

function record(workflowId, workflowLabel, architecture, verdict) {
  const data = load(workflowId) ?? blankData(workflowId, workflowLabel, architecture);

  // Ensure there's always an active version to accumulate outcomes on.
  if (!data.activeVersionId || !getActiveVersion(data)) {
    const id = genId();
    data.versions.push({ id, skill: null, createdAt: new Date().toISOString(), source: 'initial', outcomes: { accepts: 0, rejects: 0 } });
    data.activeVersionId = id;
  }

  const ver = getActiveVersion(data);
  if (verdict === 'ACCEPT') ver.outcomes.accepts++;
  else                      ver.outcomes.rejects++;
  save(data);
}

// Add a new skill version, set it active, and evict the worst performer if over the cap.
function addVersion(workflowId, skillText, source = 'auto') {
  const data = load(workflowId);
  if (!data) return null;

  const id = genId();
  data.versions.push({ id, skill: skillText, createdAt: new Date().toISOString(), source, outcomes: { accepts: 0, rejects: 0 } });

  if (data.versions.length > MAX_VERSIONS) {
    const evictables = data.versions.filter(v => v.id !== id);
    evictables.sort((a, b) => {
      const ta = a.outcomes.accepts + a.outcomes.rejects;
      const tb = b.outcomes.accepts + b.outcomes.rejects;
      const ra = ta > 0 ? a.outcomes.accepts / ta : -1;
      const rb = tb > 0 ? b.outcomes.accepts / tb : -1;
      if (ra !== rb) return ra - rb; // ascending — worst first
      return new Date(a.createdAt) - new Date(b.createdAt); // oldest first on tie
    });
    data.versions = data.versions.filter(v => v.id !== evictables[0].id);
  }

  data.activeVersionId = id;
  save(data);
  return id;
}

// Backward-compat shim for any callers using setSkill.
function setSkill(workflowId, skillText) {
  addVersion(workflowId, skillText, 'manual');
}

function activateVersion(workflowId, versionId) {
  const data = load(workflowId);
  if (!data || !data.versions.find(v => v.id === versionId)) return null;
  data.activeVersionId = versionId;
  save(data);
  return data;
}

function deleteVersion(workflowId, versionId) {
  const data = load(workflowId);
  if (!data) return null;
  if (data.activeVersionId === versionId) throw new Error('Cannot delete the active version');
  data.versions = data.versions.filter(v => v.id !== versionId);
  save(data);
  return data;
}

function setLocked(workflowId, locked) {
  const data = load(workflowId);
  if (!data) return null;
  data.skillLocked = Boolean(locked);
  save(data);
  return data;
}

function saveNotes(workflowId, notes) {
  const data = load(workflowId);
  if (!data) return;
  data.notes = notes;
  save(data);
}

function getSummary(workflowId) {
  const data = load(workflowId);
  if (!data) return null;

  const activeVer = getActiveVersion(data);
  const parts = [];

  if (activeVer?.skill) {
    parts.push(`Prompt engineering notes for this workflow (learned from previous sessions):\n${activeVer.skill}`);
  }

  const enabledNotes = (data.notes ?? []).filter(n => n.enabled);

  const enforced = enabledNotes.filter(n => n.type === 'enforce');
  if (enforced.length) {
    parts.push(`Active style enforcements (MUST apply to every prompt):\n${enforced.map(n => `- ${n.text}`).join('\n')}`);
  }

  const blacklistWords = enabledNotes.filter(n => n.type === 'blacklist').flatMap(n => n.words ?? []);
  if (blacklistWords.length) {
    parts.push(`Words to avoid in all prompts (blacklisted): ${blacklistWords.join(', ')}`);
  }

  if (parts.length) return parts.join('\n\n');

  // Fallback: show raw stats when no skill text exists yet.
  const o = activeVer?.outcomes;
  if (!o || (o.accepts + o.rejects) === 0) return null;
  const total = o.accepts + o.rejects;
  const rate  = Math.round((o.accepts / total) * 100);
  return `Outcome history for this workflow: ${o.accepts}/${total} accepted (${rate}%)`;
}

function getBlacklist(workflowId) {
  const data = load(workflowId);
  if (!data) return [];
  return (data.notes ?? [])
    .filter(n => n.enabled && n.type === 'blacklist')
    .flatMap(n => n.words ?? []);
}

function get(workflowId) {
  return load(workflowId);
}

module.exports = { record, setSkill, addVersion, activateVersion, deleteVersion, setLocked, saveNotes, getSummary, getBlacklist, get };

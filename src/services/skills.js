'use strict';

const fs   = require('fs');
const path = require('path');

const skillsDir = () => process.env.SKILLS_DIR || path.join(__dirname, '../../data/skills');

function skillPath(workflowId) {
  return path.join(skillsDir(), `${workflowId}.json`);
}

function ensureDir() {
  fs.mkdirSync(skillsDir(), { recursive: true });
}

function load(workflowId) {
  try { return JSON.parse(fs.readFileSync(skillPath(workflowId), 'utf8')); } catch { return null; }
}

function save(data) {
  ensureDir();
  fs.writeFileSync(skillPath(data.workflowId), JSON.stringify(data, null, 2));
}

function blankData(workflowId, workflowLabel, architecture) {
  return { workflowId, workflowLabel, architecture, skill: null, skillUpdatedAt: null, outcomes: { accepts: 0, rejects: 0 }, notes: [] };
}

function record(workflowId, workflowLabel, architecture, verdict) {
  const existing = load(workflowId) ?? blankData(workflowId, workflowLabel, architecture);
  if (!existing.outcomes) existing.outcomes = { accepts: 0, rejects: 0 };
  const o = existing.outcomes;
  if (verdict === 'ACCEPT') o.accepts++;
  else                      o.rejects++;
  save(existing);
}

function setSkill(workflowId, skillText) {
  const existing = load(workflowId);
  if (!existing) return;
  existing.skill          = skillText;
  existing.skillUpdatedAt = new Date().toISOString();
  save(existing);
}

function saveNotes(workflowId, notes) {
  const existing = load(workflowId);
  if (!existing) return;
  existing.notes = notes;
  save(existing);
}

// Returns skill text + any enabled enforce/blacklist notes for injection into LLM prompts.
function getSummary(workflowId) {
  const data = load(workflowId);
  if (!data) return null;

  const parts = [];

  if (data.skill) {
    parts.push(`Prompt engineering notes for this workflow (learned from previous sessions):\n${data.skill}`);
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

  // Fallback: raw outcome counts if no skill yet
  const o = data.outcomes;
  if (!o || (o.accepts + o.rejects) === 0) return null;
  const total = o.accepts + o.rejects;
  const rate  = Math.round((o.accepts / total) * 100);
  return `Outcome history for this workflow: ${o.accepts}/${total} accepted (${rate}%)`;
}

// Returns enabled blacklist words for hard post-processing of generated prompts.
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

module.exports = { record, setSkill, saveNotes, getSummary, getBlacklist, get };

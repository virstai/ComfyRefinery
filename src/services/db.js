'use strict';

const fs   = require('fs');
const path = require('path');

const sessionsDir = () => process.env.SESSIONS_DIR || path.join(__dirname, '../../data/sessions');

function ensureDir() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
}

function sessionPath(id) {
  return path.join(sessionsDir(), `${id}.json`);
}

// `touch: false` keeps the existing updatedAt — for housekeeping writes that
// must not reorder the history list (which sorts by updatedAt).
function saveSession(session, { touch = true } = {}) {
  ensureDir();
  const data = { ...session, updatedAt: touch ? new Date().toISOString() : (session.updatedAt ?? session.createdAt) };
  fs.writeFileSync(sessionPath(session.id), JSON.stringify(data, null, 2));
}

function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionPath(id), 'utf8')); } catch { return null; }
}

function listSessions(limit = 100) {
  ensureDir();
  try {
    return fs.readdirSync(sessionsDir())
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
      .slice(0, limit);
  } catch { return []; }
}

function deleteSession(id) {
  try { fs.unlinkSync(sessionPath(id)); } catch { /* ignore if already gone */ }
}

module.exports = { saveSession, loadSession, listSessions, deleteSession };

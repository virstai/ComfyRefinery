'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-db-test-'));
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.SESSIONS_DIR;
});

// Require after env var is set so lazy path evaluation picks it up
const db = require('../../src/services/db');

const session = (id, extra = {}) => ({
  id,
  description: 'test description',
  modelId: 'test',
  modelLabel: 'Test',
  iterations: [],
  status: 'complete',
  createdAt: new Date().toISOString(),
  ...extra,
});

test('saveSession writes a file, loadSession reads it back', () => {
  const s = session('aaa-111');
  db.saveSession(s);
  const loaded = db.loadSession('aaa-111');
  assert.equal(loaded.id, 'aaa-111');
  assert.equal(loaded.description, 'test description');
  assert.ok(loaded.updatedAt);
});

test('loadSession returns null for a missing id', () => {
  assert.equal(db.loadSession('does-not-exist'), null);
});

test('listSessions returns sessions sorted newest first', () => {
  // Write files directly so we control updatedAt (saveSession always stamps now)
  const dir = process.env.SESSIONS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bbb-001.json'),
    JSON.stringify({ ...session('bbb-001'), updatedAt: '2024-01-01T00:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'bbb-002.json'),
    JSON.stringify({ ...session('bbb-002'), updatedAt: '2024-06-01T00:00:00Z' }));

  const list = db.listSessions().filter(s => s.id === 'bbb-001' || s.id === 'bbb-002');
  const ids  = list.map(s => s.id);
  assert.ok(ids.indexOf('bbb-002') < ids.indexOf('bbb-001'), 'newer session should come first');
});

test('deleteSession removes the file; subsequent load returns null', () => {
  db.saveSession(session('ccc-del'));
  assert.ok(db.loadSession('ccc-del') !== null);
  db.deleteSession('ccc-del');
  assert.equal(db.loadSession('ccc-del'), null);
});

test('deleteSession is idempotent (no throw on missing id)', () => {
  assert.doesNotThrow(() => db.deleteSession('ghost-session'));
});

test('saveSession with touch:false keeps the existing updatedAt (housekeeping must not reorder history)', () => {
  const s = { ...session('touch-000'), updatedAt: '2020-01-01T00:00:00.000Z' };
  db.saveSession(s, { touch: false });
  assert.equal(db.loadSession('touch-000').updatedAt, '2020-01-01T00:00:00.000Z');
  db.saveSession(s);
  assert.notEqual(db.loadSession('touch-000').updatedAt, '2020-01-01T00:00:00.000Z');
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

let appPort, appServer, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-queue-routes-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl: 'http://127.0.0.1:11434/v1', llmModel: 'test',
    comfyuiUrl: 'http://127.0.0.1:8188',
    models: {}, workflows: {}, activeWorkflow: null,
  }));

  const { server } = require('../../server');
  appServer = server;
  await new Promise(r => appServer.listen(0, r));
  appPort = appServer.address().port;
});

after(async () => {
  await new Promise(r => appServer.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.SESSIONS_DIR;
  delete process.env.SKILLS_DIR;
});

test('GET /api/queue returns state with pending/running/done arrays', async () => {
  const res  = await fetch(`http://127.0.0.1:${appPort}/api/queue`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.pending));
  assert.ok(Array.isArray(body.done));
  assert.ok('running' in body);
});

test('DELETE /api/queue/:id returns 404 for unknown id', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/queue/nonexistent-id`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 404);
});

test('POST /api/queue/:id/stop returns 404 for unknown id', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/queue/nonexistent-id/stop`, {
    method: 'POST',
  });
  assert.equal(res.status, 404);
});

test('GET /api/queue/events returns SSE stream', async () => {
  const ac  = new AbortController();
  const res = await fetch(`http://127.0.0.1:${appPort}/api/queue/events`, {
    signal: ac.signal,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  ac.abort();
});

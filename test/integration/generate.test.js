'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI, collectSSE } = require('../support/fakeServers');

// ── Shared verdict state ──────────────────────────────────────────────────────
let reviewVerdict = 'ACCEPT';

// ── Test lifecycle ────────────────────────────────────────────────────────────
let appPort;
let ollamaServer, comfyServer, appServer;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-gen-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => reviewVerdict);
  comfyServer  = makeFakeComfyUI();
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);
  const ollamaPort = ollamaServer.address().port;
  const comfyPort  = comfyServer.address().port;

  process.env.OLLAMA_URL  = `http://127.0.0.1:${ollamaPort}`;
  process.env.COMFYUI_URL = `http://127.0.0.1:${comfyPort}`;

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    ollamaUrl:             `http://127.0.0.1:${ollamaPort}`,
    comfyuiUrl:            `http://127.0.0.1:${comfyPort}`,
    llmModel:              'test-model',
    llmProvider:           'ollama',
    activeWorkflow:        'test-wf-sd15',
    maxIterations:         3,
    humanReview:           false,
    acceptanceGracePeriod: 0,  // disabled by default so tests don't wait
    models: {
      'test-sd15': {
        id: 'test-sd15', label: 'Test SD1.5', architecture: 'sd15',
        checkpoint: 'test.safetensors',
      },
    },
    workflows: {
      'test-wf-sd15': {
        id: 'test-wf-sd15', label: 'Test Workflow SD1.5',
        steps: [{ type: 'generate', modelId: 'test-sd15', params: {}, review: {} }],
      },
    },
  }));

  const { server } = require('../../server');
  appServer = server;
  await new Promise(r => appServer.listen(0, r));
  appPort = appServer.address().port;
});

after(async () => {
  await Promise.all([
    new Promise(r => appServer.close(r)),
    new Promise(r => ollamaServer.close(r)),
    new Promise(r => comfyServer.close(r)),
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.SESSIONS_DIR;
  delete process.env.SKILLS_DIR;
  delete process.env.OLLAMA_URL;
  delete process.env.COMFYUI_URL;
});

// ── Helper ────────────────────────────────────────────────────────────────────
const base = () => `http://127.0.0.1:${appPort}`;

// ── POST /api/generate ────────────────────────────────────────────────────────

test('POST /api/generate streams all expected events and accepts on first iteration', async () => {
  reviewVerdict = 'ACCEPT';
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a happy cat' });
  const types  = new Set(events.map(e => e.event));

  for (const expected of ['session', 'step', 'phase', 'prompt', 'progress', 'image', 'review', 'done']) {
    assert.ok(types.has(expected), `missing ${expected} event`);
  }

  const done = events.find(e => e.event === 'done').data;
  assert.ok(done.accepted,         'should be accepted');
  assert.equal(done.iterations, 1, 'should complete in one iteration');
  assert.ok(done.imageUrl,         'done event should include imageUrl');
  assert.equal(done.prompt, 'a happy cat', 'done event should echo the prompt');
});

test('done event includes prompt so the frontend can populate the continue bar', async () => {
  reviewVerdict = 'REJECT';
  const events = await collectSSE(`${base()}/api/generate`, {
    prompt: 'a mountain landscape',
    overrides: { maxIterations: 1 },
  });

  const done = events.find(e => e.event === 'done').data;
  assert.equal(done.accepted, false);
  assert.equal(done.prompt, 'a mountain landscape');
  assert.ok(done.imageUrl, 'imageUrl should be set even on reject');
});

test('runs up to maxIterations when every iteration is rejected', async () => {
  reviewVerdict = 'REJECT';
  const events = await collectSSE(`${base()}/api/generate`, {
    prompt: 'abstract art',
    overrides: { maxIterations: 2 },
  });

  assert.equal(
    events.filter(e => e.event === 'prompt').length,
    2,
    'should have run exactly 2 prompt iterations',
  );

  const done = events.find(e => e.event === 'done').data;
  assert.equal(done.accepted,   false);
  assert.equal(done.iterations, 2);
});

// ── POST /api/generate/run ────────────────────────────────────────────────────

test('POST /api/generate/run accepts humanReview=false and workflowId overrides', async () => {
  reviewVerdict = 'ACCEPT';
  const events = await collectSSE(`${base()}/api/generate/run`, {
    prompt:      'a sunset over the ocean',
    humanReview: false,
    workflowId:  'test-wf-sd15',
    overrides:   { width: 768, height: 512 },
  });

  const done = events.find(e => e.event === 'done').data;
  assert.ok(done.accepted);
  assert.ok(done.sessionId);
  assert.ok(done.imageUrl);
});

test('POST /api/generate/run returns 400 for missing prompt', async () => {
  const res = await fetch(`${base()}/api/generate/run`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'prompt is required');
});

test('POST /api/generate/run returns 400 for unknown workflowId', async () => {
  const res = await fetch(`${base()}/api/generate/run`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ prompt: 'test', workflowId: 'ghost-workflow' }),
  });
  assert.equal(res.status, 400);
});

// ── Acceptance grace period ───────────────────────────────────────────────────

test('accepted_pending event fires when acceptanceGracePeriod > 0 and session completes after timer', async () => {
  reviewVerdict = 'ACCEPT';
  const events = await collectSSE(`${base()}/api/generate/run`, {
    prompt:                'a grace period test image',
    acceptanceGracePeriod: 1,
  });

  const pending = events.find(e => e.event === 'accepted_pending');
  assert.ok(pending, 'accepted_pending event should be emitted');
  assert.equal(pending.data.gracePeriod, 1);
  assert.ok(pending.data.iteration > 0);

  const done = events.find(e => e.event === 'done').data;
  assert.ok(done.accepted, 'session should complete as accepted after grace period expires');
});

// ── POST /sessions/:id/refuse-accepted ───────────────────────────────────────

test('refuse-accepted marks the accepted iteration as REFUSED on a completed session', async () => {
  reviewVerdict = 'ACCEPT';
  const events    = await collectSSE(`${base()}/api/generate`, { prompt: 'refuse test' });
  const sessionId = events.find(e => e.event === 'session').data.id;
  assert.ok(events.find(e => e.event === 'done').data.accepted);

  const refuseRes = await fetch(`${base()}/api/generate/sessions/${sessionId}/refuse-accepted`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(refuseRes.status, 204);

  const session = await (await fetch(`${base()}/api/generate/sessions/${sessionId}`)).json();
  const last = session.steps[0].iterations.at(-1);
  assert.equal(last.verdict, 'REFUSED', 'latest iteration should be marked REFUSED');
});

test('refuse-accepted returns 400 when no iteration has ACCEPT verdict', async () => {
  reviewVerdict = 'REJECT';
  const events    = await collectSSE(`${base()}/api/generate`, {
    prompt: 'all rejected', overrides: { maxIterations: 1 },
  });
  const sessionId = events.find(e => e.event === 'session').data.id;

  const res = await fetch(`${base()}/api/generate/sessions/${sessionId}/refuse-accepted`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 400);
});

test('refuse-accepted returns 404 for unknown session', async () => {
  const res = await fetch(`${base()}/api/generate/sessions/no-such-id/refuse-accepted`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 404);
});

// ── POST /api/generate/continue/:id ──────────────────────────────────────────

test('POST /api/generate/continue/:id resumes an incomplete session and runs new iterations', async () => {
  // First pass: reject so the session ends without acceptance.
  reviewVerdict = 'REJECT';
  const events1   = await collectSSE(`${base()}/api/generate`, {
    prompt: 'a continuing scene', overrides: { maxIterations: 1 },
  });
  const sessionId = events1.find(e => e.event === 'session').data.id;
  assert.equal(events1.find(e => e.event === 'done').data.accepted, false);

  // Second pass: accept.
  reviewVerdict = 'ACCEPT';
  const events2 = await collectSSE(`${base()}/api/generate/continue/${sessionId}`, {
    overrides: { maxIterations: 1 },
  });

  // The continue stream replays history then runs new iterations.
  const history = events2.filter(e => e.event === 'history');
  assert.equal(history.length, 1, 'should replay the one prior iteration as history');

  const done2 = events2.find(e => e.event === 'done').data;
  assert.ok(done2.accepted, 'continued session should accept');
});

// ── Sessions API ──────────────────────────────────────────────────────────────

test('session is persisted to disk and retrievable via GET /sessions/:id', async () => {
  reviewVerdict = 'ACCEPT';
  const events    = await collectSSE(`${base()}/api/generate`, { prompt: 'a forest path' });
  const sessionId = events.find(e => e.event === 'session').data.id;

  const data = await (await fetch(`${base()}/api/generate/sessions/${sessionId}`)).json();
  assert.equal(data.id,     sessionId);
  assert.equal(data.prompt, 'a forest path');
  assert.equal(data.status, 'complete');
  assert.ok(data.steps[0].iterations.length > 0);
  assert.ok(data.steps[0].iterations[0].prompt, 'iteration should have a generated prompt');
});

test('GET /api/generate/sessions lists persisted sessions with summary fields', async () => {
  reviewVerdict = 'ACCEPT';
  await collectSSE(`${base()}/api/generate`, { prompt: 'session list test' });

  const sessions = await (await fetch(`${base()}/api/generate/sessions`)).json();
  assert.ok(Array.isArray(sessions));
  assert.ok(sessions.length > 0);

  const our = sessions.find(s => s.prompt === 'session list test');
  assert.ok(our,                         'our session should appear in the list');
  assert.ok(our.id,                      'should have id');
  assert.equal(our.status, 'complete');
  assert.ok(typeof our.iterationCount === 'number', 'should have iterationCount');
});

test('DELETE /api/generate/sessions/:id removes the session', async () => {
  reviewVerdict = 'ACCEPT';
  const events    = await collectSSE(`${base()}/api/generate`, { prompt: 'delete me' });
  const sessionId = events.find(e => e.event === 'session').data.id;

  const del = await fetch(`${base()}/api/generate/sessions/${sessionId}`, { method: 'DELETE' });
  assert.equal(del.status, 204);

  const get = await fetch(`${base()}/api/generate/sessions/${sessionId}`);
  assert.equal(get.status, 404);
});

// ── POST /api/sessions/skills/:workflowId/refresh ────────────────────────────────

test('POST /api/sessions/skills/test-wf-sd15/refresh returns updated skill data', async () => {
  // Run a session first so outcome data exists for the workflow
  reviewVerdict = 'ACCEPT';
  await collectSSE(`${base()}/api/generate`, { prompt: 'skill refresh seed' });

  const res = await fetch(`${base()}/api/sessions/skills/test-wf-sd15/refresh`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.skill,          'should contain updated skill text');
  assert.ok(data.skillUpdatedAt, 'should have a skillUpdatedAt timestamp');
});

test('POST /api/sessions/skills/test-wf-sd15/refresh with correction note updates skill', async () => {
  const res = await fetch(`${base()}/api/sessions/skills/test-wf-sd15/refresh`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ note: 'Always use danbooru tags, never natural language.' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.skill, 'should return updated skill data after correction note');
});

test('POST /api/sessions/skills/unknown-workflow/refresh returns 404', async () => {
  const res = await fetch(`${base()}/api/sessions/skills/unknown-workflow/refresh`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error);
});

test('DELETE /api/generate/sessions?status=error deletes matching sessions', async () => {
  // Create a fake error session on disk
  const errorSession = {
    id: 'bulk-delete-test-id', prompt: 'test', workflowId: 'wf',
    workflowLabel: 'wf', references: [], steps: [], status: 'error',
    createdAt: new Date().toISOString(),
  };
  const sessDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, `${errorSession.id}.json`), JSON.stringify(errorSession));

  const res  = await fetch(`http://127.0.0.1:${appPort}/api/generate/sessions?status=error`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.deleted >= 1);
  assert.ok(!fs.existsSync(path.join(sessDir, `${errorSession.id}.json`)));
});

test('DELETE /api/generate/sessions?status=all deletes all sessions', async () => {
  // Create two sessions
  const sessDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  for (const [id, status] of [['bulk-all-1', 'complete'], ['bulk-all-2', 'running']]) {
    fs.writeFileSync(path.join(sessDir, `${id}.json`), JSON.stringify({
      id, prompt: 'x', workflowId: 'wf', workflowLabel: 'wf',
      references: [], steps: [], status, createdAt: new Date().toISOString(),
    }));
  }

  const res = await fetch(`http://127.0.0.1:${appPort}/api/generate/sessions?status=all`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.deleted >= 2);
});

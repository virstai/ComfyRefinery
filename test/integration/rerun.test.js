'use strict';

// Integration tests for partial re-runs (POST /api/generate/rerun/:id) and
// per-step variant selection (POST /api/generate/sessions/:id/select).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI, collectSSE } = require('../support/fakeServers');

let reviewVerdict = 'ACCEPT';

let appPort;
let ollamaServer, comfyServer, appServer;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-rerun-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => reviewVerdict);
  comfyServer  = makeFakeComfyUI();
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);

  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:            `http://127.0.0.1:${ollamaServer.address().port}/v1`,
    comfyuiUrl:            `http://127.0.0.1:${comfyServer.address().port}`,
    llmModel:              'test-model',
    llmProvider:           'openai',
    activeWorkflow:        'test-wf-2step',
    maxIterations:         1,
    humanReview:           false,
    acceptanceGracePeriod: 0,
    models: {
      'test-sd15': {
        id: 'test-sd15', label: 'Test SD1.5', architecture: 'sd15',
        checkpoint: 'test.safetensors',
      },
    },
    workflows: {
      'test-wf-2step': {
        id: 'test-wf-2step', label: 'Two-Step Workflow',
        steps: [
          { type: 'generate', modelId: 'test-sd15', params: {}, review: {} },
          { type: 'generate', modelId: 'test-sd15', params: {}, review: {} },
        ],
      },
    },
  }));

  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'skills'),   { recursive: true });

  Object.keys(require.cache).forEach(k => { delete require.cache[k]; });
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
});

const base = () => `http://127.0.0.1:${appPort}`;

async function getSession(id) {
  return (await fetch(`${base()}/api/generate/sessions/${id}`)).json();
}

async function runFullSession() {
  reviewVerdict = 'ACCEPT';
  const events    = await collectSSE(`${base()}/api/generate`, { prompt: 'a rerun test scene' });
  const sessionId = events.find(e => e.event === 'session').data.id;
  assert.ok(events.find(e => e.event === 'done').data.accepted, 'initial run should accept');
  return sessionId;
}

test('rerun fromStep=1 keeps step 0 and appends a new iteration to step 1', async () => {
  const sessionId = await runFullSession();
  const beforeSession = await getSession(sessionId);
  assert.equal(beforeSession.steps[0].iterations.length, 1);
  assert.equal(beforeSession.steps[1].iterations.length, 1);

  const promptsBefore = comfyServer.prompts.length;
  const events = await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 1 });

  const sessionEvt = events.find(e => e.event === 'session');
  assert.ok(sessionEvt.data.resume, 'rerun stream should announce resume');

  // History for both steps is replayed
  const history = events.filter(e => e.event === 'history');
  assert.equal(history.filter(h => h.data.step === 0).length, 1);
  assert.equal(history.filter(h => h.data.step === 1).length, 1);

  // Exactly one new ComfyUI generation (step 1 only — step 0 untouched)
  assert.equal(comfyServer.prompts.length - promptsBefore, 1, 'only step 1 should generate');

  const after = await getSession(sessionId);
  assert.equal(after.steps[0].iterations.length, 1, 'step 0 iterations unchanged');
  assert.equal(after.steps[1].iterations.length, 2, 'step 1 gained a new iteration');
  assert.equal(after.status, 'complete');

  const done = events.find(e => e.event === 'done').data;
  assert.ok(done.accepted);
});

test('rerun fromStep=toStep redoes a single step without touching later steps', async () => {
  const sessionId = await runFullSession();
  const promptsBefore = comfyServer.prompts.length;

  const events = await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });
  assert.ok(events.find(e => e.event === 'done'), 'rerun should complete');
  assert.equal(comfyServer.prompts.length - promptsBefore, 1, 'only step 0 should generate');

  const after = await getSession(sessionId);
  assert.equal(after.steps[0].iterations.length, 2, 'step 0 gained a variant');
  assert.equal(after.steps[1].iterations.length, 1, 'step 1 untouched');
});

test('iterations record the sampling seed', async () => {
  const sessionId = await runFullSession();
  const session = await getSession(sessionId);
  const it = session.steps[0].iterations[0];
  assert.ok(Number.isInteger(it.seed), 'iteration should carry an integer seed');
});

test('select marks a variant as the step output and rerun chains from it', async () => {
  const sessionId = await runFullSession();
  // Add a second variant on step 0
  await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });

  // Select the first variant explicitly
  const selRes = await fetch(`${base()}/api/generate/sessions/${sessionId}/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepIndex: 0, iteration: 1 }),
  });
  assert.equal(selRes.status, 200);
  const sel = await selRes.json();
  assert.equal(sel.selectedIteration, 1);

  const session = await getSession(sessionId);
  assert.equal(session.steps[0].selectedIteration, 1);
  assert.equal(session.steps[0].outputImageUrl, session.steps[0].iterations[0].imageUrl);

  // Rerun downstream — the chained input is re-uploaded from the selected output
  const uploadsBefore = comfyServer.uploads.length;
  const events = await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 1 });
  assert.ok(events.find(e => e.event === 'done'));
  assert.ok(comfyServer.uploads.length > uploadsBefore, 'chained input should be re-uploaded');

  // The replayed history flags the selected variant
  const selectedHistory = events.filter(e => e.event === 'history' && e.data.selected);
  assert.equal(selectedHistory.length, 1);
  assert.equal(selectedHistory[0].data.step, 0);
  assert.equal(selectedHistory[0].data.iteration, 1);
});

test('a fresh run of a step clears its previous variant selection', async () => {
  const sessionId = await runFullSession();
  await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });
  await fetch(`${base()}/api/generate/sessions/${sessionId}/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepIndex: 0, iteration: 1 }),
  });

  await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });
  const session = await getSession(sessionId);
  assert.equal(session.steps[0].selectedIteration, null, 'new run supersedes the selection');
  assert.equal(session.steps[0].iterations.length, 3);
  assert.equal(session.steps[0].outputImageUrl, session.steps[0].iterations.at(-1).imageUrl);
});

test('select validates its inputs', async () => {
  const sessionId = await runFullSession();

  let res = await fetch(`${base()}/api/generate/sessions/${sessionId}/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepIndex: 0, iteration: 99 }),
  });
  assert.equal(res.status, 400);

  res = await fetch(`${base()}/api/generate/sessions/${sessionId}/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepIndex: 7, iteration: 1 }),
  });
  assert.equal(res.status, 400);

  res = await fetch(`${base()}/api/generate/sessions/no-such-id/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepIndex: 0, iteration: 1 }),
  });
  assert.equal(res.status, 404);
});

test('rerun validates step ranges and session id', async () => {
  const sessionId = await runFullSession();

  let res = await fetch(`${base()}/api/generate/rerun/${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromStep: 5 }),
  });
  assert.equal(res.status, 400);

  res = await fetch(`${base()}/api/generate/rerun/${sessionId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromStep: 1, toStep: 9 }),
  });
  assert.equal(res.status, 400);

  res = await fetch(`${base()}/api/generate/rerun/no-such-id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromStep: 0 }),
  });
  assert.equal(res.status, 404);
});

test('refuse-accepted honors an explicit stepIndex/iterationN target', async () => {
  const sessionId = await runFullSession();
  // Two accepted variants on step 0
  await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });

  const res = await fetch(`${base()}/api/generate/sessions/${sessionId}/refuse-accepted`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepIndex: 0, iterationN: 1 }),
  });
  assert.equal(res.status, 204);

  const session = await getSession(sessionId);
  assert.equal(session.steps[0].iterations[0].verdict, 'REFUSED', 'targeted iteration refused');
  assert.equal(session.steps[0].iterations[1].verdict, 'ACCEPT', 'other variant untouched');
  assert.equal(session.steps[1].iterations[0].verdict, 'ACCEPT', 'later step untouched');
});

test('rerun refuses a workflow whose step types changed even when the count did not', async () => {
  const sessionId = await runFullSession();
  const cfgPath   = path.join(tmpDir, 'config.json');
  const original  = fs.readFileSync(cfgPath, 'utf8');
  const cfg       = JSON.parse(original);
  // Same length, but step 2 is now an upscale — a rerun would write image
  // iterations into a slot the session still calls "generate".
  cfg.workflows['test-wf-2step'].steps[1] = { type: 'upscale', upscaleType: 'model', upscaleModel: 'x.pth', factor: 2, review: {} };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  try {
    const res = await fetch(`${base()}/api/generate/rerun/${sessionId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromStep: 1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /step 2 is now upscale, was generate/);
  } finally {
    fs.writeFileSync(cfgPath, original);
  }
});

test('step_complete carries the cleared selection so the client can re-sync', async () => {
  const sessionId = await runFullSession();
  await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });
  await fetch(`${base()}/api/generate/sessions/${sessionId}/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepIndex: 0, iteration: 1 }),
  });
  const events = await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });
  assert.ok(events.find(e => e.event === 'history' && e.data.selected), 'replay shows the old pick');
  const complete = events.find(e => e.event === 'step_complete' && e.data.step === 0);
  assert.ok(complete, 'step_complete emitted');
  assert.equal(complete.data.selectedIteration, null, 'fresh run cleared the pick');
});

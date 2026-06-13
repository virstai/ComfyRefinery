'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI, collectSSE } = require('../support/fakeServers');
const { TINY_PNG } = require('../support/fakeServers');

let appPort;
let ollamaServer, comfyServer, appServer;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-ref-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => 'ACCEPT');
  comfyServer  = makeFakeComfyUI();
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);
  const ollamaPort = ollamaServer.address().port;
  const comfyPort  = comfyServer.address().port;

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:            `http://127.0.0.1:${ollamaPort}/v1`,
    comfyuiUrl:            `http://127.0.0.1:${comfyPort}`,
    llmModel:              'test-model',
    llmProvider:           'openai',
    activeWorkflow:        'test-wf',
    maxIterations:         3,
    humanReview:           false,
    acceptanceGracePeriod: 0,
    models: {
      'test-sd15': { id: 'test-sd15', label: 'Test SD1.5', architecture: 'sd15', checkpoint: 'test.safetensors' },
    },
    workflows: {
      'test-wf': {
        id: 'test-wf', label: 'Test Workflow',
        steps: [{
          type: 'generate', modelId: 'test-sd15', params: {}, review: {},
          referenceStrategy: {
            visionNotes: false,
            diffusion: { none: 'txt2img', one: { mode: 'init-image', denoise: 0.6 }, many: { mode: 'txt2img' } },
          },
        }],
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
});

test('POST /api/references/upload calls ComfyUI /upload/image and returns ref array', async () => {
  const base64 = TINY_PNG.toString('base64');
  const uploadsBefore = comfyServer.uploads.length;

  const res = await fetch(`http://127.0.0.1:${appPort}/api/references/upload`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ files: [{ name: 'test.png', data: base64 }] }),
  });
  assert.equal(res.status, 200);

  const refs = await res.json();
  assert.equal(refs.length, 1);
  assert.equal(typeof refs[0].filename, 'string');
  assert.equal(typeof refs[0].subfolder, 'string');
  assert.equal(typeof refs[0].type, 'string');
  assert.equal(comfyServer.uploads.length, uploadsBefore + 1, 'ComfyUI /upload/image should have been called once');
});

test('POST /api/references/upload returns 400 when files array is missing', async () => {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/references/upload`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/references/upload accepts data URL prefix', async () => {
  const dataUrl = `data:image/png;base64,${TINY_PNG.toString('base64')}`;
  const res = await fetch(`http://127.0.0.1:${appPort}/api/references/upload`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ files: [{ name: 'photo.png', data: dataUrl }] }),
  });
  assert.equal(res.status, 200);
  const refs = await res.json();
  assert.equal(refs.length, 1);
});

test('POST /api/generate stores references on session', async () => {
  const refs = [{ filename: 'uploaded.png', subfolder: '', type: 'input' }];
  const events = await collectSSE(`http://127.0.0.1:${appPort}/api/generate`, {
    prompt: 'a test image', references: refs,
  });

  const sessionEvent = events.find(e => e.event === 'session');
  assert.ok(sessionEvent, 'session event should be emitted');
  const sessionId = sessionEvent.data.id;

  const sessionRes = await fetch(`http://127.0.0.1:${appPort}/api/generate/sessions/${sessionId}`);
  const session = await sessionRes.json();
  assert.deepEqual(session.references, refs, 'references should be persisted on the session');
});

test('POST /api/generate with no references stores empty array', async () => {
  const events = await collectSSE(`http://127.0.0.1:${appPort}/api/generate`, {
    prompt: 'a test image',
  });
  const sessionId = events.find(e => e.event === 'session').data.id;
  const session = await (await fetch(`http://127.0.0.1:${appPort}/api/generate/sessions/${sessionId}`)).json();
  assert.deepEqual(session.references, []);
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeVideoFakeComfyUI, collectSSE } = require('../support/fakeServers');

let appPort;
let ollamaServer, comfyServer, appServer;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-video-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => 'ACCEPT');
  comfyServer  = makeVideoFakeComfyUI();
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);
  const ollamaPort = ollamaServer.address().port;
  const comfyPort  = comfyServer.address().port;

  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'skills'),   { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:            `http://127.0.0.1:${ollamaPort}/v1`,
    comfyuiUrl:            `http://127.0.0.1:${comfyPort}`,
    llmModel:              'test-model',
    llmProvider:           'openai',
    activeWorkflow:        'test-video-wf',
    maxIterations:         3,
    humanReview:           false,
    acceptanceGracePeriod: 0,
    models: {
      'test-wanvideo': {
        id: 'test-wanvideo', label: 'Test WanVideo', architecture: 'wanvideo',
        unetName: 'wan.safetensors', vaeName: 'vae.safetensors', clipName: 'clip.safetensors',
      },
    },
    workflows: {
      'test-video-wf': {
        id: 'test-video-wf', label: 'Test Video Workflow',
        steps: [
          { type: 'video', modelId: 'test-wanvideo', params: { frames: 49, fps: 16, steps: 30, guidance: 6, width: 832, height: 480 } },
        ],
      },
    },
  }));

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

test('video-only workflow: emits step event with type=video', async () => {
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a flowing river' });
  const stepEvents = events.filter(e => e.event === 'step').map(e => e.data);
  assert.equal(stepEvents.length, 1,        'one step event');
  assert.equal(stepEvents[0].type, 'video', 'step type is video');
  assert.equal(stepEvents[0].index, 0,      'step index 0');
});

test('video-only workflow: emits progress events', async () => {
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a spinning top' });
  const progressEvents = events.filter(e => e.event === 'progress');
  assert.ok(progressEvents.length > 0, 'at least one progress event');
  assert.ok(progressEvents.every(e => e.data.step === 0), 'all progress events for step 0');
});

test('video-only workflow: emits video event with /api/video url', async () => {
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a mountain' });
  const videoEvt = events.find(e => e.event === 'video');
  assert.ok(videoEvt,                                   'video event emitted');
  assert.ok(videoEvt.data.url,                          'video event has url');
  assert.ok(videoEvt.data.url.startsWith('/api/video'), 'url uses /api/video proxy');
});

test('video-only workflow: done event accepted=true and has videoUrl', async () => {
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a forest' });
  const done = events.find(e => e.event === 'done');
  assert.ok(done,              'done event emitted');
  assert.ok(done.data.accepted, 'pipeline accepted');
  assert.ok(done.data.videoUrl, 'done has videoUrl');
  assert.equal(done.data.imageUrl, null, 'done imageUrl is null for video step');
});

test('video-only workflow: no review or image events emitted', async () => {
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a desert' });
  assert.equal(events.filter(e => e.event === 'review').length,       0, 'no review events');
  assert.equal(events.filter(e => e.event === 'human_review').length, 0, 'no human_review events');
  assert.equal(events.filter(e => e.event === 'image').length,        0, 'no image events');
});

test('video-only workflow: session has outputVideoUrl and empty iterations', async () => {
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a waterfall' });
  const sessionId = events.find(e => e.event === 'session').data.id;

  const res     = await fetch(`${base()}/api/generate/sessions/${sessionId}`);
  const session = await res.json();

  assert.equal(session.steps.length,               1,       'one step');
  assert.equal(session.steps[0].type,              'video', 'step type video');
  assert.equal(session.steps[0].iterations.length, 0,       'no iterations');
  assert.ok(session.steps[0].outputVideoUrl,                'outputVideoUrl set');
  assert.equal(session.status, 'complete',                  'session complete');
});

test('video workflow: submits exactly one ComfyUI prompt with CreateVideo + SaveVideo output', async () => {
  const promptsBefore = comfyServer.prompts.length;
  await collectSSE(`${base()}/api/generate`, { prompt: 'a lake' });

  const submitted = comfyServer.prompts.slice(promptsBefore);
  assert.equal(submitted.length, 1, 'one ComfyUI prompt submitted');

  const wfNodes = Object.values(submitted[0].prompt);
  assert.ok(
    wfNodes.some(n => n.class_type === 'CreateVideo'),
    'submitted workflow has CreateVideo',
  );
  assert.ok(
    wfNodes.some(n => n.class_type === 'SaveVideo'),
    'submitted workflow has SaveVideo',
  );
});

'use strict';

// Ad-hoc steps: POST /api/generate/sessions/:id/steps appends a video step to
// a session whose workflow has none (e.g. an API-driven generate), and /rerun
// runs it from the chosen image. The session's own steps stay untouched.

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-add-step-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => 'ACCEPT');
  comfyServer  = makeVideoFakeComfyUI({ withImages: true });
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);

  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'skills'),   { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:            `http://127.0.0.1:${ollamaServer.address().port}/v1`,
    comfyuiUrl:            `http://127.0.0.1:${comfyServer.address().port}`,
    llmModel:              'test-model',
    llmProvider:           'openai',
    activeWorkflow:        'test-wf-image-only',
    maxIterations:         1,
    humanReview:           false,
    acceptanceGracePeriod: 0,
    models: {
      'test-sd15':     { id: 'test-sd15', label: 'Test SD1.5', architecture: 'sd15', checkpoint: 'test.safetensors' },
      'test-wanvideo': { id: 'test-wanvideo', label: 'Test WanVideo', architecture: 'wanvideo',
                         unetName: 'wan.safetensors', vaeName: 'vae.safetensors', clipName: 'clip.safetensors' },
    },
    workflows: {
      'test-wf-image-only': {
        id: 'test-wf-image-only', label: 'Image only',
        steps: [{ type: 'generate', modelId: 'test-sd15', params: {}, review: {} }],
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
const getSession = async id => (await fetch(`${base()}/api/generate/sessions/${id}`)).json();
const post = (url, body) => fetch(`${base()}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function runImageSession() {
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a still scene' });
  assert.ok(events.find(e => e.event === 'done').data.accepted);
  return events.find(e => e.event === 'session').data.id;
}

test('a video step can be appended to an image-only session and run from its image', async () => {
  const sessionId = await runImageSession();

  const res = await post(`/api/generate/sessions/${sessionId}/steps`, { type: 'video', modelId: 'test-wanvideo', inputFrom: 0, iteration: 1 });
  assert.equal(res.status, 200);
  const { stepIndex } = await res.json();
  assert.equal(stepIndex, 1);

  let session = await getSession(sessionId);
  assert.equal(session.steps.length, 2);
  assert.equal(session.steps[1].type, 'video');
  assert.equal(session.extraSteps.length, 1);
  assert.equal(session.extraSteps[0].inputFrom, 0);

  const events = await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 1, toStep: 1 });
  assert.ok(events.find(e => e.event === 'step' && e.data.index === 1 && e.data.type === 'video'));
  assert.ok(events.find(e => e.event === 'video' && e.data.step === 1), 'video event for the new step');
  assert.ok(events.find(e => e.event === 'done').data.accepted);

  session = await getSession(sessionId);
  assert.equal(session.steps[0].iterations.length, 1, 'image step untouched');
  assert.equal(session.steps[1].iterations.length, 1, 'one take');
  assert.match(session.steps[1].iterations[0].videoUrl, /^\/api\/video\?/);
  assert.ok(session.steps[1].outputVideoUrl);

  // The I2V job was queued with the image step's output as its init image
  const videoPrompt = comfyServer.prompts.at(-1);
  const loadImage   = Object.values(videoPrompt.prompt).find(n => n.class_type === 'LoadImage');
  assert.ok(loadImage, 'video graph loads the chained image');
});

test('the extra step survives a redo of the workflow step (no drift error)', async () => {
  const sessionId = await runImageSession();
  await post(`/api/generate/sessions/${sessionId}/steps`, { type: 'video', modelId: 'test-wanvideo', inputFrom: 0 });
  const events = await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: 0, toStep: 0 });
  assert.ok(events.find(e => e.event === 'done'), 'redo of step 0 accepted with the extra step present');
  const session = await getSession(sessionId);
  assert.equal(session.steps.length, 2);
  assert.equal(session.steps[0].iterations.length, 2);
});

test('add-step validates its inputs', async () => {
  const sessionId = await runImageSession();
  const cases = [
    [{ type: 'video', modelId: 'nope',          inputFrom: 0 }, /not found/],
    [{ type: 'video', modelId: 'test-sd15',     inputFrom: 0 }, /not a video model/],
    [{ type: 'video', modelId: 'test-wanvideo', inputFrom: 5 }, /No step 5/],
    [{ type: 'video', modelId: 'test-wanvideo', inputFrom: 0, iteration: 9 }, /out of range/],
    [{ type: 'upscale', modelId: 'test-wanvideo', inputFrom: 0 }, /Only video steps/],
  ];
  for (const [body, re] of cases) {
    const res = await post(`/api/generate/sessions/${sessionId}/steps`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, re);
  }
  const missing = await post(`/api/generate/sessions/does-not-exist/steps`, { type: 'video', modelId: 'test-wanvideo', inputFrom: 0 });
  assert.equal(missing.status, 404);
});

test('steering notes on an added video step reach the prompt builder', async () => {
  const sessionId = await runImageSession();
  const res = await post(`/api/generate/sessions/${sessionId}/steps`, { type: 'video', modelId: 'test-wanvideo', inputFrom: 0, steering: '  Low angle, hold on the face. Sound: wind only.  ' });
  assert.equal(res.status, 200);
  const { stepIndex } = await res.json();
  assert.equal((await getSession(sessionId)).extraSteps[0].steering, 'Low angle, hold on the face. Sound: wind only.');
  const before = ollamaServer.requests.length;
  await collectSSE(`${base()}/api/generate/rerun/${sessionId}`, { fromStep: stepIndex, toStep: stepIndex });
  const videoReq = ollamaServer.requests.slice(before).find(r => r.messages.some(m => /video generation prompts/.test(typeof m.content === 'string' ? m.content : '')));
  assert.ok(videoReq, 'a video prompt request was made');
  // I2V inserts the reference image as the first user message; the description follows it.
  const texts = videoReq.messages.filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string' ? m.content : m.content.map(p => p.text ?? '').join(''));
  const desc = texts.find(t => t.startsWith('Description:'));
  assert.ok(desc, 'description message present');
  assert.match(desc, /Director's notes[\s\S]*Low angle, hold on the face\. Sound: wind only\./);
});

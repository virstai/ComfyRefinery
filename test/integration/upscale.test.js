'use strict';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-upscale-test-'));
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

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:            `http://127.0.0.1:${ollamaPort}/v1`,
    comfyuiUrl:            `http://127.0.0.1:${comfyPort}`,
    llmModel:              'test-model',
    llmProvider:           'openai',
    activeWorkflow:        'test-upscale-wf',
    maxIterations:         3,
    humanReview:           false,
    acceptanceGracePeriod: 0,
    models: {
      'test-sd15': {
        id: 'test-sd15', label: 'Test SD1.5', architecture: 'sd15',
        checkpoint: 'test.safetensors',
      },
    },
    workflows: {
      'test-upscale-wf': {
        id: 'test-upscale-wf', label: 'Test Generate + Upscale',
        steps: [
          { type: 'generate', modelId: 'test-sd15', params: {}, review: { maxIterations: 1 } },
          { type: 'upscale', upscaleModel: '4x-UltraSharp.pth', factor: 4, review: { maxIterations: 1 } },
        ],
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

const base = () => `http://127.0.0.1:${appPort}`;

test('generate + upscale workflow fires step events for both steps in order', async () => {
  reviewVerdict = 'ACCEPT';
  const events = await collectSSE(`${base()}/api/generate`, { prompt: 'a happy cat' });

  const stepEvents = events.filter(e => e.event === 'step').map(e => e.data);
  assert.equal(stepEvents.length, 2, 'should have two step events');
  assert.equal(stepEvents[0].type,  'generate', 'first step type');
  assert.equal(stepEvents[1].type,  'upscale',  'second step type');
  assert.equal(stepEvents[0].index, 0,          'first step index');
  assert.equal(stepEvents[1].index, 1,          'second step index');
  assert.equal(stepEvents[0].total, 2,          'total steps');
  assert.equal(stepEvents[1].total, 2,          'total steps');

  const done = events.find(e => e.event === 'done').data;
  assert.ok(done.accepted, 'pipeline should complete as accepted');
});

test('upscale step re-uploads the previous step output via POST /upload/image', async () => {
  reviewVerdict = 'ACCEPT';
  const uploadsBefore = comfyServer.uploads.length;
  await collectSSE(`${base()}/api/generate`, { prompt: 'a mountain lake' });
  // upscale step fetches the generate output and re-uploads it as an input
  assert.equal(comfyServer.uploads.length, uploadsBefore + 1, 'one upload from the upscale step');
});

test('upscale step sends a ComfyUI prompt containing UpscaleModelLoader', async () => {
  reviewVerdict = 'ACCEPT';
  const promptsBefore = comfyServer.prompts.length;
  await collectSSE(`${base()}/api/generate`, { prompt: 'a forest path' });

  const submitted = comfyServer.prompts.slice(promptsBefore);
  assert.equal(submitted.length, 2, 'two ComfyUI prompts submitted (one per step)');

  const upscaleWorkflow = submitted[1].prompt;
  const nodeTypes = Object.values(upscaleWorkflow).map(n => n.class_type);
  assert.ok(nodeTypes.includes('UpscaleModelLoader'),    'upscale prompt has UpscaleModelLoader');
  assert.ok(nodeTypes.includes('ImageUpscaleWithModel'), 'upscale prompt has ImageUpscaleWithModel');
  assert.ok(nodeTypes.includes('LoadImage'),             'upscale prompt has LoadImage');
  assert.ok(nodeTypes.includes('SaveImage'),             'upscale prompt has SaveImage');
});

test('session has two steps entries with outputImageUrl after pipeline completes', async () => {
  reviewVerdict = 'ACCEPT';
  const events    = await collectSSE(`${base()}/api/generate`, { prompt: 'a serene valley' });
  const sessionId = events.find(e => e.event === 'session').data.id;

  const res     = await fetch(`${base()}/api/generate/sessions/${sessionId}`);
  const session = await res.json();

  assert.equal(session.steps.length,    2,          'two steps in session');
  assert.equal(session.steps[0].type,   'generate', 'step 0 type');
  assert.equal(session.steps[1].type,   'upscale',  'step 1 type');
  assert.ok(session.steps[0].outputImageUrl, 'generate step has outputImageUrl');
  assert.ok(session.steps[1].outputImageUrl, 'upscale step has outputImageUrl');
  assert.equal(session.status, 'complete', 'session status is complete');
});

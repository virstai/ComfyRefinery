'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI, collectSSE } = require('../support/fakeServers');

let reviewVerdict = 'ACCEPT';

let appPort, ollamaServer, comfyServer, appServer, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-pose-fallback-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  // No DWPreprocessor in objectInfo — pose node is absent
  ollamaServer = makeFakeOllama(() => reviewVerdict);
  comfyServer  = makeFakeComfyUI({});
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);
  process.env.OLLAMA_URL  = `http://127.0.0.1:${ollamaServer.address().port}`;
  process.env.COMFYUI_URL = `http://127.0.0.1:${comfyServer.address().port}`;

  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:  `http://127.0.0.1:${ollamaServer.address().port}/v1`,
    comfyuiUrl:  `http://127.0.0.1:${comfyServer.address().port}`,
    llmModel:    'test-model',
    activeWorkflow: 'wf-pose-always',
    maxIterations: 1, humanReview: false, acceptanceGracePeriod: 0,
    loras: {
      'anima_turbo.safetensors': { filename: 'anima_turbo.safetensors', label: 'Turbo', architecture: 'anima', triggerWords: ['turbo'], description: 'speed', defaultWeight: 1.0, autoDetected: false },
    },
    models: {
      'anima-base': { id: 'anima-base', label: 'Anima', architecture: 'anima', unetName: 'anima.safetensors', clipL: 'qwen.safetensors', vaeName: 'vae.safetensors' },
      'pose-draft': { id: 'pose-draft', label: 'Pose Draft', architecture: 'sd15', checkpoint: 'fast.safetensors' },
    },
    workflows: {
      'wf-pose-always': {
        id: 'wf-pose-always', label: 'Pose Always',
        steps: [{
          type: 'generate', modelId: 'anima-base', params: {},
          loras: [{ name: 'anima_turbo.safetensors', weight: 1.0 }],
          llmLoras: true,
          controlNet: { poseMode: 'always', poseModelId: 'pose-draft', controlNetModel: 'anima_lllite_pose.safetensors', strength: 0.8 },
          review: { maxIterations: 1 },
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
  for (const k of ['DATA_DIR', 'SESSIONS_DIR', 'SKILLS_DIR', 'OLLAMA_URL', 'COMFYUI_URL']) delete process.env[k];
});

const base = () => `http://127.0.0.1:${appPort}`;
const nodeTypes = wf => Object.values(wf).map(n => n.class_type);

test('missing DWPose node: warning event, generation continues without controlnet', async () => {
  reviewVerdict = 'ACCEPT';
  comfyServer.prompts.length = 0;

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'a knight', workflowId: 'wf-pose-always' });

  const warning = events.find(e => e.event === 'warning');
  assert.ok(warning, 'warning event emitted');
  assert.match(warning.data.message, /DWPreprocessor/);

  assert.equal(comfyServer.prompts.length, 1, 'only the main run');
  assert.ok(!nodeTypes(comfyServer.prompts[0].prompt).includes('AnimaLLLiteLoader'), 'no controlnet in main graph');
  assert.ok(events.find(e => e.event === 'done').data.accepted, 'pipeline completed normally');

  const done2   = events.find(e => e.event === 'done').data;
  const session = await (await fetch(`${base()}/api/generate/sessions/${done2.sessionId}`)).json();
  assert.match(session.steps[0].iterations[0].warnings[0], /DWPreprocessor/, 'warning persisted on iteration');
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI, collectSSE } = require('../support/fakeServers');

let appPort, ollamaServer, comfyServer, appServer, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-capabilities-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => 'ACCEPT');
  comfyServer  = makeFakeComfyUI();
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
    activeWorkflow: 'wf-chroma-lora',
    maxIterations: 1, humanReview: false, acceptanceGracePeriod: 0,
    loras: {
      'chroma_detail.safetensors': { filename: 'chroma_detail.safetensors', label: 'Detail', architecture: 'chroma', triggerWords: [], description: 'detail boost', defaultWeight: 1.0, autoDetected: false },
    },
    models: {
      'chroma-base': { id: 'chroma-base', label: 'Chroma', architecture: 'chroma', unetName: 'chroma.safetensors', clipName: 't5.safetensors', vaeName: 'ae.safetensors' },
    },
    workflows: {
      'wf-chroma-lora': {
        id: 'wf-chroma-lora', label: 'Chroma + LoRA',
        steps: [{
          type: 'generate', modelId: 'chroma-base', params: {},
          loras: [{ name: 'chroma_detail.safetensors', weight: 0.9 }],
          review: { maxIterations: 1 },
        }],
      },
      'wf-chroma-pose': {
        id: 'wf-chroma-pose', label: 'Chroma + Pose (invalid)',
        steps: [{
          type: 'generate', modelId: 'chroma-base', params: {},
          controlNet: { poseMode: 'always', strength: 1.0 },
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

test('chroma step with always-on lora: LoraLoader lands in the ComfyUI graph', async () => {
  comfyServer.prompts.length = 0;

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'a knight', workflowId: 'wf-chroma-lora' });

  assert.ok(events.find(e => e.event === 'done')?.data.accepted, 'run accepted');
  assert.equal(comfyServer.prompts.length, 1);
  const graph = comfyServer.prompts[0].prompt;
  const lora  = Object.values(graph).find(n => n.class_type === 'LoraLoader');
  assert.ok(lora, 'LoraLoader present in the chroma graph');
  assert.equal(lora.inputs.lora_name, 'chroma_detail.safetensors');
  assert.equal(lora.inputs.strength_model, 0.9);

  const session = await (await fetch(`${base()}/api/generate/sessions/${events.find(e => e.event === 'done').data.sessionId}`)).json();
  assert.equal(session.steps[0].iterations[0].loras[0].name, 'chroma_detail.safetensors');
});

test('pose mode on chroma (no controlNet capability) fails the step with a clear error', async () => {
  comfyServer.prompts.length = 0;

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'a knight', workflowId: 'wf-chroma-pose' });

  const err = events.find(e => e.event === 'error');
  assert.ok(err, 'error event emitted');
  assert.match(err.data.message, /not supported on the "chroma" architecture/);
  assert.equal(comfyServer.prompts.length, 0, 'no generation ran');
});

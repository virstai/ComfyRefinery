'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI, collectSSE } = require('../support/fakeServers');

let reviewVerdict = 'ACCEPT';
let toolCallScript = () => []; // per-test: parsed request body → tool calls

let appPort, ollamaServer, comfyServer, appServer, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-loras-pose-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  ollamaServer = makeFakeOllama(() => reviewVerdict, { getToolCalls: parsed => toolCallScript(parsed) });
  comfyServer  = makeFakeComfyUI({
    objectInfo: { DWPreprocessor: { input: { required: {} } } },
  });
  await Promise.all([
    new Promise(r => ollamaServer.listen(0, r)),
    new Promise(r => comfyServer.listen(0, r)),
  ]);
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    llmBaseUrl:  `http://127.0.0.1:${ollamaServer.address().port}/v1`,
    comfyuiUrl:  `http://127.0.0.1:${comfyServer.address().port}`,
    llmModel:    'test-model',
    activeWorkflow: 'wf-pose-always',
    maxIterations: 1, humanReview: false, acceptanceGracePeriod: 0,
    loras: {
      'anima_turbo.safetensors': { filename: 'anima_turbo.safetensors', label: 'Turbo', architecture: 'anima', triggerWords: ['turbo'], description: 'speed', defaultWeight: 1.0, autoDetected: false },
      'anima_style.safetensors': { filename: 'anima_style.safetensors', label: 'Style', architecture: 'anima', triggerWords: [], description: 'style', defaultWeight: 0.8, autoDetected: false },
    },
    models: {
      'anima-base': { id: 'anima-base', label: 'Anima', architecture: 'anima', unetName: 'anima.safetensors', clipL: 'qwen.safetensors', vaeName: 'vae.safetensors', controlNetModel: 'anima_lllite_pose.safetensors' },
    },
    workflows: {
      'wf-pose-always': {
        id: 'wf-pose-always', label: 'Pose Always',
        steps: [{
          type: 'generate', modelId: 'anima-base', params: {},
          loras: [{ name: 'anima_turbo.safetensors', weight: 1.0 }],
          llmLoras: true,
          controlNet: { poseMode: 'always', strength: 0.8 },
          review: { maxIterations: 1 },
        }],
      },
      'wf-pose-auto': {
        id: 'wf-pose-auto', label: 'Pose Auto',
        steps: [{
          type: 'generate', modelId: 'anima-base', params: {},
          llmLoras: true,
          controlNet: { poseMode: 'auto', strength: 0.8 },
          review: { maxIterations: 1 },
        }],
      },
      'wf-plain': {
        id: 'wf-plain', label: 'Plain',
        steps: [{ type: 'generate', modelId: 'anima-base', params: {}, review: { maxIterations: 1 } }],
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
  for (const k of ['DATA_DIR', 'SESSIONS_DIR', 'SKILLS_DIR']) delete process.env[k];
});

const base = () => `http://127.0.0.1:${appPort}`;
const nodeTypes = wf => Object.values(wf).map(n => n.class_type);

test('poseMode always: pose graph runs first, main graph gets LLLite + always-on lora', async () => {
  reviewVerdict  = 'ACCEPT';
  toolCallScript = () => []; // model never calls tools — pose still runs (always)
  comfyServer.prompts.length = 0;

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'a knight', workflowId: 'wf-pose-always' });

  const phases = events.filter(e => e.event === 'phase').map(e => e.data.phase);
  assert.ok(phases.includes('posing'), 'posing phase emitted');
  assert.ok(events.some(e => e.event === 'pose' && e.data.url), 'pose event with url');

  assert.equal(comfyServer.prompts.length, 2, 'pose run + main run');
  const poseGraph = comfyServer.prompts[0].prompt;
  const mainGraph = comfyServer.prompts[1].prompt;
  assert.ok(nodeTypes(poseGraph).includes('DWPreprocessor'), 'pose graph extracts skeleton');

  // No request_pose call was made, so the draft falls back to the raw user
  // prompt wrapped in the detection-friendly template.
  const draftPositive = Object.values(poseGraph)
    .find(n => n.class_type === 'CLIPTextEncode' && n.inputs.text.includes('a knight'));
  assert.ok(draftPositive, 'draft prompt built from the user description');
  assert.match(draftPositive.inputs.text, /fully inside the frame/, 'detection-friendly template applied');
  assert.ok(nodeTypes(mainGraph).includes('AnimaLLLiteApply'), 'main graph has LLLite node');
  assert.ok(nodeTypes(mainGraph).includes('LoraLoader'), 'always-on lora applied');

  // Session iteration records pose + loras
  const done    = events.find(e => e.event === 'done').data;
  const session = await (await fetch(`${base()}/api/generate/sessions/${done.sessionId}`)).json();
  const iter    = session.steps[0].iterations[0];
  assert.equal(iter.poseUsed, true);
  assert.ok(iter.poseImageUrl);
  assert.equal(iter.loras[0].name, 'anima_turbo.safetensors');
  assert.equal(iter.loras[0].source, 'step');
});

test('poseMode auto: LLM tool calls add a lora and request the pose', async () => {
  reviewVerdict  = 'ACCEPT';
  comfyServer.prompts.length = 0;
  let systemContent = '';
  toolCallScript = parsed => {
    systemContent = parsed.messages[0]?.content ?? '';
    // Only respond with tool calls on the first round (no tool results yet)
    if (parsed.messages.some(m => m.role === 'tool')) return [];
    return [
      { name: 'add_lora',     args: { name: 'anima_style.safetensors', weight: 0.5 } },
      { name: 'request_pose', args: { description: 'a dancer mid-leap, both legs extended, full body airborne' } },
    ];
  };

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'a dancer mid-leap', workflowId: 'wf-pose-auto' });

  // Tool guidance must be in the system prompt — tool schemas alone don't
  // make local models call tools when the prompt says "output only the prompt".
  assert.match(systemContent, /request_pose/, 'pose guidance present in system prompt');
  assert.match(systemContent, /add_lora/, 'lora guidance present in system prompt');

  assert.equal(comfyServer.prompts.length, 2, 'pose ran because the LLM requested it');

  // The draft uses the LLM-supplied pose description, not the styled prompt
  const poseGraph = comfyServer.prompts[0].prompt;
  const draftPositive = Object.values(poseGraph)
    .find(n => n.class_type === 'CLIPTextEncode' && n.inputs.text.includes('a dancer mid-leap, both legs extended'));
  assert.ok(draftPositive, 'LLM pose description used for the draft');

  const mainGraph = comfyServer.prompts[1].prompt;
  const lora = Object.values(mainGraph).find(n => n.class_type === 'LoraLoader');
  assert.equal(lora.inputs.lora_name, 'anima_style.safetensors');
  assert.equal(lora.inputs.strength_model, 0.5);

  const done    = events.find(e => e.event === 'done').data;
  const session = await (await fetch(`${base()}/api/generate/sessions/${done.sessionId}`)).json();
  assert.equal(session.steps[0].iterations[0].loras[0].source, 'llm');

  const reviewEvt = events.find(e => e.event === 'review');
  assert.equal(reviewEvt.data.loras[0].name, 'anima_style.safetensors', 'review event carries live loras');
  assert.equal(reviewEvt.data.poseUsed, true);
});

test('poseMode auto without request_pose: single run, no pose', async () => {
  reviewVerdict  = 'ACCEPT';
  comfyServer.prompts.length = 0;
  toolCallScript = () => [];

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'a misty forest', workflowId: 'wf-pose-auto' });

  assert.equal(comfyServer.prompts.length, 1, 'no pose run');
  assert.ok(!events.some(e => e.event === 'pose'), 'no pose event');
  assert.ok(!events.filter(e => e.event === 'phase').some(e => e.data.phase === 'posing'));
});

test('plain workflow (no llmLoras/controlNet): no tools sent to the LLM, behaviour unchanged', async () => {
  reviewVerdict  = 'ACCEPT';
  comfyServer.prompts.length = 0;
  let sawTools = false;
  toolCallScript = parsed => { if (parsed.tools) sawTools = true; return []; };

  const events = await collectSSE(`${base()}/api/generate/run`, { prompt: 'a cat', workflowId: 'wf-plain' });

  assert.equal(sawTools, false, 'no tools offered');
  assert.equal(comfyServer.prompts.length, 1);
  assert.ok(events.find(e => e.event === 'done').data.accepted);
});

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeOllama, makeFakeComfyUI } = require('../support/fakeServers');

let reviewVerdict = 'ACCEPT';

let appPort;
let ollamaServer, comfyServer, appServer;
let tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-sdapi-test-'));
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
    maxIterations:         2,
    humanReview:           false,
    acceptanceGracePeriod: 0,
    models: {
      'test-sd15': {
        id: 'test-sd15', label: 'Test SD1.5', architecture: 'sd15',
        checkpoint: 'test.safetensors',
      },
      'test-sdxl': {
        id: 'test-sdxl', label: 'Test SDXL', architecture: 'sdxl',
        checkpoint: 'test-xl.safetensors',
      },
    },
    workflows: {
      'test-wf-sd15': {
        id: 'test-wf-sd15', label: 'Test SD1.5',
        steps: [{ type: 'generate', modelId: 'test-sd15', params: {}, review: {} }],
      },
      'test-wf-sdxl': {
        id: 'test-wf-sdxl', label: 'Test SDXL',
        steps: [{ type: 'generate', modelId: 'test-sdxl', params: {}, review: {} }],
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

const base    = () => `http://127.0.0.1:${appPort}`;
const sdapi   = (path) => `${base()}/sdapi/v1${path}`;
const postJSON = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ── POST /sdapi/v1/txt2img ────────────────────────────────────────────────────

test('POST /sdapi/v1/txt2img returns base64 image, echoed parameters, and info JSON', async () => {
  reviewVerdict = 'ACCEPT';
  const res  = await postJSON(sdapi('/txt2img'), { prompt: 'a tiger in golden light' });
  assert.equal(res.status, 200);
  const data = await res.json();

  // images array
  assert.ok(Array.isArray(data.images),        'images should be an array');
  assert.equal(data.images.length, 1,           'should contain one image');
  assert.ok(data.images[0].length > 0,           'base64 payload should be non-empty');
  assert.ok(Buffer.from(data.images[0], 'base64').length > 0, 'should decode to valid bytes');

  // parameters echo
  assert.ok(data.parameters,                   'parameters should be present');
  assert.equal(data.parameters.prompt, 'a tiger in golden light');

  // info is a JSON string
  assert.ok(typeof data.info === 'string',     'info should be a JSON string');
  const info = JSON.parse(data.info);
  assert.equal(info.prompt, 'a tiger in golden light');
  assert.ok('seed' in info);
});

test('POST /sdapi/v1/txt2img maps negative_prompt, steps, cfg_scale, width, height', async () => {
  reviewVerdict = 'ACCEPT';
  const res  = await postJSON(sdapi('/txt2img'), {
    prompt:          'a fox',
    negative_prompt: 'blurry',
    steps:           20,
    cfg_scale:       5.0,
    width:           768,
    height:          512,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.images.length, 1);
  // Verify the override values were echoed back in parameters
  assert.equal(data.parameters.steps,           20);
  assert.equal(data.parameters.cfg_scale,       5.0);
  assert.equal(data.parameters.negative_prompt, 'blurry');
});

test('POST /sdapi/v1/txt2img maps sampler_name to internal sampler', async () => {
  reviewVerdict = 'ACCEPT';
  // Test both an exact match and a Karras variant; both should complete without error.
  for (const sampler_name of ['Euler a', 'DPM++ 2M Karras']) {
    const res = await postJSON(sdapi('/txt2img'), { prompt: 'a wolf', sampler_name });
    assert.equal(res.status, 200, `${sampler_name} should succeed`);
    const data = await res.json();
    assert.equal(data.images.length, 1);
  }
});

test('POST /sdapi/v1/txt2img with batch_size=2 returns 2 images', async () => {
  reviewVerdict = 'ACCEPT';
  const res  = await postJSON(sdapi('/txt2img'), { prompt: 'a cat', batch_size: 2 });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.images.length, 2, 'batch_size=2 should produce 2 images');
  // Seeds should be sequential
  const info = JSON.parse(data.info);
  assert.equal(info.all_seeds.length, 2);
});

test('POST /sdapi/v1/txt2img with override_settings.sd_model_checkpoint selects model by label', async () => {
  reviewVerdict = 'ACCEPT';
  const res  = await postJSON(sdapi('/txt2img'), {
    prompt:            'a dragon',
    override_settings: { sd_model_checkpoint: 'Test SDXL' },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.images.length, 1);
  const info = JSON.parse(data.info);
  assert.equal(info.model, 'test-sdxl', 'info.model should reflect the overridden model id');
});

test('POST /sdapi/v1/txt2img selects model by "Label [id]" format', async () => {
  reviewVerdict = 'ACCEPT';
  const res = await postJSON(sdapi('/txt2img'), {
    prompt:            'a whale',
    override_settings: { sd_model_checkpoint: 'Test SDXL [test-sdxl]' },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(JSON.parse(data.info).model, 'test-sdxl');
});

test('POST /sdapi/v1/txt2img returns 400 when prompt is missing', async () => {
  const res = await postJSON(sdapi('/txt2img'), {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error, 'should return an error message');
});

test('POST /sdapi/v1/txt2img falls back to active workflow when override_settings model is unrecognised', async () => {
  // Unrecognised checkpoint names (e.g. "automatic1111" echoed by some clients) should
  // fall back to the active workflow rather than returning a hard 400.
  const res = await postJSON(sdapi('/txt2img'), {
    prompt:            'test',
    override_settings: { sd_model_checkpoint: 'NonExistentModel' },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.images));
});

test('POST /sdapi/v1/txt2img with rejection loops returns the last image when max iterations reached', async () => {
  reviewVerdict = 'REJECT';
  const res  = await postJSON(sdapi('/txt2img'), { prompt: 'a rejected prompt' });
  assert.equal(res.status, 200);
  const data = await res.json();
  // Even when not accepted, the last generated image should be returned.
  assert.equal(data.images.length, 1);
});

// ── GET /sdapi/v1/progress ────────────────────────────────────────────────────

test('GET /sdapi/v1/progress returns idle state when no job is running', async () => {
  const res  = await fetch(sdapi('/progress'));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.progress, 0);
  assert.ok('state' in data,               'should have state field');
  assert.equal(data.state.job_count, 0);
  assert.ok('current_image' in data);
});

// ── GET /sdapi/v1/sd-models ───────────────────────────────────────────────────

test('GET /sdapi/v1/sd-models returns all configured models in A1111 format', async () => {
  const res    = await fetch(sdapi('/sd-models'));
  assert.equal(res.status, 200);
  const models = await res.json();

  assert.ok(Array.isArray(models),          'should be an array');
  assert.equal(models.length, 2,            'should list both configured models');

  for (const m of models) {
    assert.ok('title'      in m, 'should have title');
    assert.ok('model_name' in m, 'should have model_name');
    assert.ok('filename'   in m, 'should have filename');
    assert.match(m.title, /\[.+\]/, 'title should be in "Label [id]" format');
  }

  assert.ok(models.some(m => m.model_name === 'Test SD1.5'));
  assert.ok(models.some(m => m.model_name === 'Test SDXL'));
});

// ── GET /POST /sdapi/v1/options ───────────────────────────────────────────────

test('GET /sdapi/v1/options returns active workflow model as sd_model_checkpoint', async () => {
  const res  = await fetch(sdapi('/options'));
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.ok('sd_model_checkpoint' in data, 'should have sd_model_checkpoint field');
  assert.ok(data.sd_model_checkpoint.includes('Test SD1.5'), 'should reflect active workflow model label');
  assert.ok(data.sd_model_checkpoint.includes('test-sd15'),  'should include model id in brackets');
});

test('POST /sdapi/v1/options switches active workflow by model id', async () => {
  const set = await postJSON(sdapi('/options'), { sd_model_checkpoint: 'test-sdxl' });
  assert.equal(set.status, 200);

  const opts = await (await fetch(sdapi('/options'))).json();
  assert.ok(opts.sd_model_checkpoint.includes('Test SDXL'));

  // Restore original active workflow for subsequent tests.
  await postJSON(sdapi('/options'), { sd_model_checkpoint: 'test-sd15' });
});

test('POST /sdapi/v1/options switches active workflow by model label', async () => {
  const set = await postJSON(sdapi('/options'), { sd_model_checkpoint: 'Test SDXL' });
  assert.equal(set.status, 200);

  const opts = await (await fetch(sdapi('/options'))).json();
  assert.ok(opts.sd_model_checkpoint.includes('test-sdxl'));

  await postJSON(sdapi('/options'), { sd_model_checkpoint: 'test-sd15' });
});

test('POST /sdapi/v1/options returns 400 for unknown model', async () => {
  const res = await postJSON(sdapi('/options'), { sd_model_checkpoint: 'Imaginary Model' });
  assert.equal(res.status, 400);
});

// ── GET /sdapi/v1/samplers ────────────────────────────────────────────────────

test('GET /sdapi/v1/samplers returns all supported samplers with correct structure', async () => {
  const res      = await fetch(sdapi('/samplers'));
  assert.equal(res.status, 200);
  const samplers = await res.json();

  assert.ok(Array.isArray(samplers),         'should be an array');
  assert.ok(samplers.length >= 5,            'should have at least 5 samplers');

  for (const s of samplers) {
    assert.ok('name'    in s, 'each sampler should have a name');
    assert.ok('aliases' in s, 'each sampler should have aliases');
    assert.ok(Array.isArray(s.aliases));
  }

  const names = samplers.map(s => s.name);
  assert.ok(names.includes('Euler'),         'should include Euler');
  assert.ok(names.includes('Euler a'),       'should include Euler a');
  assert.ok(names.includes('DPM++ 2M'),     'should include DPM++ 2M');
  assert.ok(names.includes('DDIM'),          'should include DDIM');
});

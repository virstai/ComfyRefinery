'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeFakeComfyUI } = require('../support/fakeServers');

let appPort, comfyServer, appServer, tmpDir;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-loras-test-'));
  process.env.DATA_DIR     = tmpDir;
  process.env.SESSIONS_DIR = path.join(tmpDir, 'sessions');
  process.env.SKILLS_DIR   = path.join(tmpDir, 'skills');

  comfyServer = makeFakeComfyUI({
    objectInfo: {
      LoraLoader: { input: { required: { lora_name: [['anima_turbo.safetensors', 'xl_detail.safetensors', 'mystery.safetensors'], {}] } } },
    },
    loraMetadata: {
      'anima_turbo.safetensors': { ss_base_model_version: 'anima_v1' },
      'xl_detail.safetensors':   { ss_base_model_version: 'sdxl_base_v1-0' },
      // mystery.safetensors: no metadata → architecture null
    },
  });
  await new Promise(r => comfyServer.listen(0, r));

  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
    comfyuiUrl: `http://127.0.0.1:${comfyServer.address().port}`,
    llmModel: 'test-model', models: {}, workflows: {},
  }));

  const { server } = require('../../server');
  appServer = server;
  await new Promise(r => appServer.listen(0, r));
  appPort = appServer.address().port;
});

after(async () => {
  await Promise.all([
    new Promise(r => appServer.close(r)),
    new Promise(r => comfyServer.close(r)),
  ]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const k of ['DATA_DIR', 'SESSIONS_DIR', 'SKILLS_DIR']) delete process.env[k];
});

const base = () => `http://127.0.0.1:${appPort}`;
const json = async (method, url, body) => {
  const res = await fetch(`${base()}${url}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('POST /api/sessions/loras/scan discovers loras with detected architectures', async () => {
  const { status, body } = await json('POST', '/api/sessions/loras/scan');
  assert.equal(status, 200);
  assert.equal(body.loras['anima_turbo.safetensors'].architecture, 'anima');
  assert.equal(body.loras['anima_turbo.safetensors'].autoDetected, true);
  assert.equal(body.loras['anima_turbo.safetensors'].label, 'anima_turbo');
  assert.equal(body.loras['xl_detail.safetensors'].architecture, 'sdxl');
  assert.equal(body.loras['mystery.safetensors'].architecture, null);
});

test('PUT /api/sessions/loras updates an entry and clears autoDetected', async () => {
  const { status, body } = await json('PUT', '/api/sessions/loras', {
    filename: 'mystery.safetensors',
    architecture: 'anima',
    triggerWords: ['mystery style'],
    description: 'adds mystery',
    defaultWeight: 0.7,
  });
  assert.equal(status, 200);
  assert.equal(body.architecture, 'anima');
  assert.deepEqual(body.triggerWords, ['mystery style']);
  assert.equal(body.autoDetected, false);

  const get = await json('GET', '/api/sessions/loras');
  assert.equal(get.body.loras['mystery.safetensors'].defaultWeight, 0.7);
});

test('rescan preserves user-edited entries and prunes deleted files', async () => {
  const { body } = await json('POST', '/api/sessions/loras/scan');
  assert.equal(body.loras['mystery.safetensors'].architecture, 'anima', 'user edit preserved');
  assert.equal(body.loras['mystery.safetensors'].autoDetected, false);
});

test('PUT for unregistered file returns 400', async () => {
  const { status } = await json('PUT', '/api/sessions/loras', { filename: 'nope.safetensors', label: 'x' });
  assert.equal(status, 400);
});

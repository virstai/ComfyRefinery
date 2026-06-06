'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build, defaults } = require('../../../src/workflows/cogvideox');

const BASE = {
  checkpoint:     'cogvideox.safetensors',
  vae:            'cogvideox_vae.safetensors',
  clipName:       'clip.safetensors',
  positivePrompt: 'a spinning top',
};

function nodeTypes(wf) { return Object.values(wf).map(n => n.class_type); }

test('cogvideox T2V: contains required node types', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(types.includes('CogVideoXModelLoader'),      'CogVideoXModelLoader');
  assert.ok(types.includes('CLIPLoader'),                'CLIPLoader');
  assert.ok(types.includes('CogVideoXTextEncode'),       'CogVideoXTextEncode');
  assert.ok(types.includes('CogVideoXEmptyLatentVideo'), 'CogVideoXEmptyLatentVideo');
  assert.ok(types.includes('CogVideoXSampler'),          'CogVideoXSampler');
  assert.ok(types.includes('VAEDecode'),                 'VAEDecode');
  assert.ok(types.includes('CreateVideo'),               'CreateVideo');
  assert.ok(types.includes('SaveVideo'),                 'SaveVideo');
});

test('cogvideox T2V: no LoadImage', () => {
  assert.ok(!nodeTypes(build(BASE)).includes('LoadImage'));
});

test('cogvideox I2V: includes LoadImage and CogVideoXImageEncode', () => {
  const wf = build({ ...BASE, inputRef: { filename: 'ref.png', subfolder: '' }, isI2V: true });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LoadImage'),           'LoadImage');
  assert.ok(types.includes('CogVideoXImageEncode'), 'CogVideoXImageEncode');
});

test('cogvideox T2V: default dimensions applied', () => {
  const wf = build(BASE);
  const latent = Object.values(wf).find(n => n.class_type === 'CogVideoXEmptyLatentVideo');
  assert.equal(latent.inputs.width,      defaults.width);
  assert.equal(latent.inputs.height,     defaults.height);
  assert.equal(latent.inputs.num_frames, defaults.frames);
});

test('cogvideox T2V: CreateVideo uses fps', () => {
  const wf = build({ ...BASE, fps: 8 });
  const cv = Object.values(wf).find(n => n.class_type === 'CreateVideo');
  assert.equal(cv.inputs.fps, 8);
});

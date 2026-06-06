'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build, defaults } = require('../../../src/workflows/ltxvideo');

const BASE = {
  unetName:       'ltx_video.safetensors',
  vaeName:        'ltx_vae.safetensors',
  clipName:       't5xxl.safetensors',
  positivePrompt: 'a flowing river',
};

function nodeTypes(wf) { return Object.values(wf).map(n => n.class_type); }

test('ltxvideo T2V: contains required node types', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(types.includes('LTXVLoader'),          'LTXVLoader');
  assert.ok(types.includes('CLIPLoader'),           'CLIPLoader');
  assert.ok(types.includes('LTXVTextEncode'),       'LTXVTextEncode');
  assert.ok(types.includes('EmptyLTXVLatentVideo'), 'EmptyLTXVLatentVideo');
  assert.ok(types.includes('LTXVSampler'),          'LTXVSampler');
  assert.ok(types.includes('VAEDecode'),            'VAEDecode');
  assert.ok(types.includes('CreateVideo'),          'CreateVideo');
  assert.ok(types.includes('SaveVideo'),            'SaveVideo');
});

test('ltxvideo T2V: no LoadImage', () => {
  assert.ok(!nodeTypes(build(BASE)).includes('LoadImage'));
});

test('ltxvideo I2V: includes LoadImage and LTXVConditioning', () => {
  const wf = build({ ...BASE, inputRef: { filename: 'img.png', subfolder: '' }, isI2V: true });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LoadImage'),        'LoadImage');
  assert.ok(types.includes('LTXVConditioning'), 'LTXVConditioning');
});

test('ltxvideo T2V: default dimensions applied', () => {
  const wf = build(BASE);
  const latent = Object.values(wf).find(n => n.class_type === 'EmptyLTXVLatentVideo');
  assert.equal(latent.inputs.width,  defaults.width);
  assert.equal(latent.inputs.height, defaults.height);
  assert.equal(latent.inputs.length, defaults.frames);
});

test('ltxvideo T2V: CreateVideo uses fps', () => {
  const wf = build({ ...BASE, fps: 30 });
  const cv = Object.values(wf).find(n => n.class_type === 'CreateVideo');
  assert.equal(cv.inputs.fps, 30);
});

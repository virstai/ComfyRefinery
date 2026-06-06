'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build, defaults } = require('../../../src/workflows/hunyuanvideo');

const BASE = {
  unetName:       'hunyuan_video.safetensors',
  vaeName:        'hv_vae.safetensors',
  clipName:       'llava_llama3.safetensors',
  positivePrompt: 'cinematic landscape',
};

function nodeTypes(wf) { return Object.values(wf).map(n => n.class_type); }

test('hunyuanvideo T2V: contains required node types', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(types.includes('HunyuanVideoModelLoader'),  'HunyuanVideoModelLoader');
  assert.ok(types.includes('CLIPLoader'),               'CLIPLoader');
  assert.ok(types.includes('HunyuanVideoTextEncode'),   'HunyuanVideoTextEncode');
  assert.ok(types.includes('EmptyHunyuanLatentVideo'),  'EmptyHunyuanLatentVideo');
  assert.ok(types.includes('KSampler'),                 'KSampler');
  assert.ok(types.includes('VAEDecode'),                'VAEDecode');
  assert.ok(types.includes('CreateVideo'),              'CreateVideo');
  assert.ok(types.includes('SaveVideo'),                'SaveVideo');
});

test('hunyuanvideo T2V: no LoadImage in T2V mode', () => {
  assert.ok(!nodeTypes(build(BASE)).includes('LoadImage'));
});

test('hunyuanvideo I2V: includes LoadImage and HunyuanVideoImageToVideo', () => {
  const wf = build({ ...BASE, inputRef: { filename: 'ref.png', subfolder: '' }, isI2V: true });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LoadImage'),                  'LoadImage');
  assert.ok(types.includes('HunyuanVideoImageToVideo'),   'HunyuanVideoImageToVideo');
});

test('hunyuanvideo T2V: applies default dimensions', () => {
  const wf = build(BASE);
  const latent = Object.values(wf).find(n => n.class_type === 'EmptyHunyuanLatentVideo');
  assert.equal(latent.inputs.width,        defaults.width);
  assert.equal(latent.inputs.height,       defaults.height);
  assert.equal(latent.inputs.video_length, defaults.frames);
});

test('hunyuanvideo T2V: CreateVideo uses fps and SaveVideo is present', () => {
  const wf = build({ ...BASE, fps: 30 });
  const cv = Object.values(wf).find(n => n.class_type === 'CreateVideo');
  const sv = Object.values(wf).find(n => n.class_type === 'SaveVideo');
  assert.equal(cv.inputs.fps, 30);
  assert.ok(sv, 'SaveVideo present');
});

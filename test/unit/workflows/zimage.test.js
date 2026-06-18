'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/zimage');

const BASE = {
  unetName:       'z_image_bf16.safetensors',
  clipName:       'qwen_3_4b.safetensors',
  vaeName:        'ae.safetensors',
  positivePrompt: 'a knight',
};

test('base graph without loras: ModelSamplingAuraFlow off the UNet, CLIPLoader type is lumina2', () => {
  const wf = build(BASE);
  assert.equal(Object.values(wf).filter(n => n.class_type === 'LoraLoader').length, 0);
  assert.deepEqual(wf['4'].inputs.model, ['1', 0], 'ModelSamplingAuraFlow off the UNet');
  assert.equal(wf['2'].inputs.type, 'lumina2', 'CLIPLoader type is lumina2');
  assert.equal(wf['4'].inputs.shift, 3, 'shift is 3');
  assert.deepEqual(wf['5'].inputs.clip, ['2', 0], 'CLIPTextEncode off the CLIP loader');
});

test('loras: chain sits between loaders and ModelSamplingAuraFlow/encode', () => {
  const wf = build({ ...BASE, loras: [
    { name: 'a.safetensors', weight: 0.7 },
    { name: 'b.safetensors', weight: 1.0 },
  ]});
  assert.deepEqual(wf['30'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['30'].inputs.clip,  ['2', 0]);
  assert.deepEqual(wf['31'].inputs.model, ['30', 0]);
  assert.deepEqual(wf['4'].inputs.model,  ['31', 0], 'ModelSamplingAuraFlow patches post-lora model');
  assert.deepEqual(wf['5'].inputs.clip,   ['31', 1], 'CLIPTextEncode reads post-lora clip');
});

test('txt2img: EmptySD3LatentImage, denoise 1.0, res_multistep sampler, simple scheduler', () => {
  const wf = build(BASE);
  assert.ok(Object.values(wf).find(n => n.class_type === 'EmptySD3LatentImage'), 'has empty latent');
  assert.equal(Object.values(wf).filter(n => n.class_type === 'VAEEncode').length, 0, 'no VAEEncode in txt2img');
  assert.equal(wf['8'].inputs.denoise,      1.0);
  assert.equal(wf['8'].inputs.sampler_name, 'res_multistep');
  assert.equal(wf['8'].inputs.scheduler,    'simple');
  assert.equal(wf['8'].inputs.cfg,          4.0);
});

test('img2img: VAEEncode replaces empty latent, default denoise 0.6', () => {
  const wf = build({ ...BASE, initImage: { filename: 'ref.png', subfolder: '' } });
  assert.equal(Object.values(wf).filter(n => n.class_type === 'EmptySD3LatentImage').length, 0, 'no empty latent');
  assert.ok(Object.values(wf).find(n => n.class_type === 'VAEEncode'), 'VAEEncode present');
  assert.equal(wf['8'].inputs.denoise, 0.6);
});

test('img2img: custom denoise respected', () => {
  const wf = build({ ...BASE, initImage: { filename: 'ref.png', subfolder: '' }, denoise: 0.4 });
  assert.equal(wf['8'].inputs.denoise, 0.4);
});

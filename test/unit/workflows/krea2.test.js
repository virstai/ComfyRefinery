'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/krea2');

const BASE = {
  unetName:       'krea2_turbo_fp8_scaled.safetensors',
  clipName:       'qwen3vl_4b_fp8_scaled.safetensors',
  vaeName:        'qwen_image_vae.safetensors',
  positivePrompt: 'a knight',
};

test('base graph without loras: no ModelSampling node, CLIPLoader type is krea2', () => {
  const wf = build(BASE);
  assert.equal(Object.values(wf).filter(n => n.class_type === 'LoraLoaderModelOnly').length, 0);
  assert.equal(Object.values(wf).filter(n => n.class_type?.startsWith('ModelSampling')).length, 0, 'no ModelSampling node');
  assert.equal(wf['2'].inputs.type, 'krea2', 'CLIPLoader type is krea2');
  assert.deepEqual(wf['5'].inputs.clip, ['2', 0], 'CLIPTextEncode off the CLIP loader directly');
  assert.deepEqual(wf['8'].inputs.model, ['1', 0], 'KSampler reads the UNet loader directly (no loras)');
});

test('loras: chain uses LoraLoaderModelOnly, never touches CLIP', () => {
  const wf = build({ ...BASE, loras: [
    { name: 'a.safetensors', weight: 0.7 },
    { name: 'b.safetensors', weight: 1.0 },
  ]});
  assert.equal(wf['30'].class_type, 'LoraLoaderModelOnly');
  assert.deepEqual(wf['30'].inputs.model, ['1', 0]);
  assert.equal(wf['30'].inputs.clip, undefined, 'no clip input on LoraLoaderModelOnly');
  assert.deepEqual(wf['31'].inputs.model, ['30', 0]);
  assert.deepEqual(wf['8'].inputs.model, ['31', 0], 'KSampler reads post-lora model');
  assert.deepEqual(wf['5'].inputs.clip, ['2', 0], 'CLIPTextEncode still reads the CLIP loader directly');
});

test('txt2img: EmptyLatentImage, denoise 1.0, euler/simple, cfg 1.0 default', () => {
  const wf = build(BASE);
  assert.ok(Object.values(wf).find(n => n.class_type === 'EmptyLatentImage'), 'has empty latent');
  assert.equal(Object.values(wf).filter(n => n.class_type === 'VAEEncode').length, 0, 'no VAEEncode in txt2img');
  assert.equal(wf['8'].inputs.denoise,      1.0);
  assert.equal(wf['8'].inputs.sampler_name, 'euler');
  assert.equal(wf['8'].inputs.scheduler,    'simple');
  assert.equal(wf['8'].inputs.cfg,          1.0);
});

test('cfg <= 1: negative is ConditioningZeroOut off the positive encode', () => {
  const wf = build(BASE);
  assert.equal(wf['6'].class_type, 'ConditioningZeroOut');
  assert.deepEqual(wf['6'].inputs.conditioning, ['5', 0]);
  assert.deepEqual(wf['8'].inputs.negative, ['6', 0]);
});

test('cfg > 1: negative is a real CLIPTextEncode of the negative prompt', () => {
  const wf = build({ ...BASE, cfgScale: 3.5, negativePrompt: 'blurry' });
  assert.equal(wf['6'].class_type, 'CLIPTextEncode');
  assert.equal(wf['6'].inputs.text, 'blurry');
  assert.deepEqual(wf['6'].inputs.clip, ['2', 0]);
  assert.equal(wf['8'].inputs.cfg, 3.5);
});

test('img2img: VAEEncode replaces empty latent, default denoise 0.6', () => {
  const wf = build({ ...BASE, initImage: { filename: 'ref.png', subfolder: '' } });
  assert.equal(Object.values(wf).filter(n => n.class_type === 'EmptyLatentImage').length, 0, 'no empty latent');
  assert.ok(Object.values(wf).find(n => n.class_type === 'VAEEncode'), 'VAEEncode present');
  assert.equal(wf['8'].inputs.denoise, 0.6);
});

test('img2img: custom denoise respected', () => {
  const wf = build({ ...BASE, initImage: { filename: 'ref.png', subfolder: '' }, denoise: 0.4 });
  assert.equal(wf['8'].inputs.denoise, 0.4);
});

test('SaveImage filename_prefix is "iterator"', () => {
  const wf = build(BASE);
  assert.equal(wf['10'].inputs.filename_prefix, 'iterator');
});

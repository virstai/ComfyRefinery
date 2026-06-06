'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build, defaults } = require('../../../src/workflows/wanvideo');

const BASE = {
  unetName:       'wan_model.safetensors',
  vaeName:        'wan_vae.safetensors',
  clipName:       'umt5.safetensors',
  positivePrompt: 'a red balloon floating',
};

const REF = { filename: 'ref.png', subfolder: '' };

function nodeTypes(workflow) {
  return Object.values(workflow).map(n => n.class_type);
}

test('wanvideo: contains all required native node types (T2V)', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(types.includes('UNETLoader'),              'UNETLoader');
  assert.ok(types.includes('VAELoader'),               'VAELoader');
  assert.ok(types.includes('CLIPLoader'),              'CLIPLoader');
  assert.ok(types.includes('CLIPTextEncode'),          'CLIPTextEncode');
  assert.ok(types.includes('ModelSamplingSD3'),        'ModelSamplingSD3');
  assert.ok(types.includes('EmptyHunyuanLatentVideo'), 'EmptyHunyuanLatentVideo');
  assert.ok(types.includes('KSampler'),                'KSampler');
  assert.ok(types.includes('VAEDecode'),               'VAEDecode');
  assert.ok(types.includes('CreateVideo'),             'CreateVideo');
  assert.ok(types.includes('SaveVideo'),               'SaveVideo');
});

test('wanvideo: no kijai custom nodes present', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(!types.includes('WanVideoModelLoader'),       'no WanVideoModelLoader');
  assert.ok(!types.includes('WanVideoVAELoader'),         'no WanVideoVAELoader');
  assert.ok(!types.includes('WanVideoTextEmbedBridge'),   'no WanVideoTextEmbedBridge');
  assert.ok(!types.includes('WanVideoSampler'),           'no WanVideoSampler');
  assert.ok(!types.includes('WanVideoDecode'),            'no WanVideoDecode');
  assert.ok(!types.includes('WanVideoImageToVideoEncode'),'no WanVideoImageToVideoEncode');
});

test('wanvideo: no LoadImage or WanImageToVideo without inputRef', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(!types.includes('LoadImage'),       'no LoadImage without ref');
  assert.ok(!types.includes('WanImageToVideo'), 'no WanImageToVideo without ref');
});

test('wanvideo I2V: uses WanImageToVideo with start_image for all model sizes', () => {
  const wf = build({ ...BASE, inputRef: REF, isI2V: true });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LoadImage'),                'LoadImage present');
  assert.ok(types.includes('WanImageToVideo'),          'WanImageToVideo present');
  assert.ok(!types.includes('Wan22ImageToVideoLatent'), 'no Wan22ImageToVideoLatent (wrong format)');

  const i2v = Object.values(wf).find(n => n.class_type === 'WanImageToVideo');
  assert.ok(Array.isArray(i2v.inputs.start_image), 'start_image linked');
  assert.ok(Array.isArray(i2v.inputs.positive),    'positive conditioning linked');
  assert.ok(Array.isArray(i2v.inputs.negative),    'negative conditioning linked');
});

test('wanvideo T2V: uses EmptyHunyuanLatentVideo (no WanImageToVideo)', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(types.includes('EmptyHunyuanLatentVideo'),  'EmptyHunyuanLatentVideo for T2V');
  assert.ok(!types.includes('WanImageToVideo'),         'no WanImageToVideo for T2V');
  assert.ok(!types.includes('Wan22ImageToVideoLatent'), 'no Wan22ImageToVideoLatent');
});

test('wanvideo: VAELoader uses vaeName', () => {
  const wf = build(BASE);
  const vaeLoader = Object.values(wf).find(n => n.class_type === 'VAELoader');
  assert.equal(vaeLoader.inputs.vae_name, 'wan_vae.safetensors');
});

test('wanvideo: UNETLoader uses unetName with weight_dtype', () => {
  const wf = build(BASE);
  const loader = Object.values(wf).find(n => n.class_type === 'UNETLoader');
  assert.equal(loader.inputs.unet_name,   'wan_model.safetensors');
  assert.equal(loader.inputs.weight_dtype, 'default');
});

test('wanvideo: modelQuantization "disabled" maps to weight_dtype "default"', () => {
  const wf = build({ ...BASE, modelQuantization: 'disabled' });
  const loader = Object.values(wf).find(n => n.class_type === 'UNETLoader');
  assert.equal(loader.inputs.weight_dtype, 'default');
});

test('wanvideo: modelQuantization fp8_e4m3fn passes through to weight_dtype', () => {
  const wf = build({ ...BASE, modelQuantization: 'fp8_e4m3fn' });
  const loader = Object.values(wf).find(n => n.class_type === 'UNETLoader');
  assert.equal(loader.inputs.weight_dtype, 'fp8_e4m3fn');
});

test('wanvideo: CLIPLoader uses clipName with type wan', () => {
  const wf = build(BASE);
  const cl = Object.values(wf).find(n => n.class_type === 'CLIPLoader');
  assert.equal(cl.inputs.clip_name, 'umt5.safetensors');
  assert.equal(cl.inputs.type, 'wan');
});

test('wanvideo: ModelSamplingSD3 shift is 8.0', () => {
  const wf = build(BASE);
  const mss = Object.values(wf).find(n => n.class_type === 'ModelSamplingSD3');
  assert.equal(mss.inputs.shift, 8.0);
});

test('wanvideo: KSampler applies cfg and steps overrides', () => {
  const wf = build({ ...BASE, steps: 25, guidance: 4.5 });
  const sampler = Object.values(wf).find(n => n.class_type === 'KSampler');
  assert.equal(sampler.inputs.steps, 25);
  assert.equal(sampler.inputs.cfg,   4.5);
});

test('wanvideo: CreateVideo uses fps and SaveVideo is present', () => {
  const wf = build({ ...BASE, fps: 24 });
  const cv = Object.values(wf).find(n => n.class_type === 'CreateVideo');
  const sv = Object.values(wf).find(n => n.class_type === 'SaveVideo');
  assert.equal(cv.inputs.fps, 24, 'fps passed to CreateVideo');
  assert.ok(sv, 'SaveVideo present');
});

test('wanvideo MoE: two UNETLoaders, two ModelSamplingSD3s, two KSamplerAdvanced', () => {
  const wf = build({ ...BASE, unetName2: 'wan_low_noise.safetensors', inputRef: REF, isI2V: true });
  const loaders  = Object.values(wf).filter(n => n.class_type === 'UNETLoader');
  const samplers = Object.values(wf).filter(n => n.class_type === 'KSamplerAdvanced');
  const msds     = Object.values(wf).filter(n => n.class_type === 'ModelSamplingSD3');
  assert.equal(loaders.length,  2, 'two UNETLoaders for MoE');
  assert.equal(samplers.length, 2, 'two KSamplerAdvanced for cascade');
  assert.equal(msds.length,     2, 'two ModelSamplingSD3 for MoE');
});

test('wanvideo MoE I2V: uses WanImageToVideo (not Wan22ImageToVideoLatent)', () => {
  const wf = build({ ...BASE, unetName2: 'wan_low_noise.safetensors', inputRef: REF, isI2V: true });
  const types = nodeTypes(wf);
  assert.ok(types.includes('WanImageToVideo'),          'WanImageToVideo for MoE I2V');
  assert.ok(!types.includes('Wan22ImageToVideoLatent'), 'no Wan22ImageToVideoLatent for MoE');
});

test('wanvideo MoE T2V: uses EmptyHunyuanLatentVideo', () => {
  const wf = build({ ...BASE, unetName2: 'wan_low_noise.safetensors' });
  const types = nodeTypes(wf);
  assert.ok(types.includes('EmptyHunyuanLatentVideo'),  'EmptyHunyuanLatentVideo for MoE T2V');
  assert.ok(!types.includes('WanImageToVideo'),         'no WanImageToVideo for T2V');
  assert.ok(!types.includes('Wan22ImageToVideoLatent'), 'no Wan22ImageToVideoLatent');
});

test('wanvideo MoE: cascade sampler start/end steps are split correctly', () => {
  const steps = 20;
  const wf = build({ ...BASE, unetName2: 'wan_low_noise.safetensors', steps, inputRef: REF, isI2V: true });
  const samplers = Object.values(wf).filter(n => n.class_type === 'KSamplerAdvanced');
  const split = Math.ceil(steps / 2);
  const first  = samplers.find(s => s.inputs.start_at_step === 0);
  const second = samplers.find(s => s.inputs.start_at_step === split);
  assert.ok(first,  'first sampler starts at 0');
  assert.ok(second, 'second sampler starts at split');
  assert.equal(first.inputs.end_at_step,   split,  'first ends at split');
  assert.equal(second.inputs.end_at_step,  10000,  'second runs to completion');
});

test('wanvideo MoE: cascade add_noise flags correct', () => {
  const wf = build({ ...BASE, unetName2: 'wan_low_noise.safetensors', inputRef: REF, isI2V: true });
  const samplers = Object.values(wf).filter(n => n.class_type === 'KSamplerAdvanced');
  const first  = samplers.find(s => s.inputs.start_at_step === 0);
  const second = samplers.find(s => s.inputs.start_at_step !== 0);
  assert.equal(first.inputs.add_noise,                   'enable',  'first adds noise');
  assert.equal(first.inputs.return_with_leftover_noise,  'enable',  'first returns leftover noise');
  assert.equal(second.inputs.add_noise,                  'disable', 'second does not add noise');
  assert.equal(second.inputs.return_with_leftover_noise, 'disable', 'second does not return leftover noise');
});

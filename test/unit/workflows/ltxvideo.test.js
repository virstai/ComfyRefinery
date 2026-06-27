'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build, defaults } = require('../../../src/workflows/ltxvideo');

const BASE = {
  checkpoint:     'ltx-2.3-22b-dev-fp8.safetensors',
  clipName:       'gemma_3_12B_it_fp4_mixed.safetensors',
  positivePrompt: 'a flowing river',
};

function nodeTypes(wf) { return Object.values(wf).map(n => n.class_type); }

test('ltxvideo T2V: contains required node types', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  assert.ok(types.includes('CheckpointLoaderSimple'), 'CheckpointLoaderSimple');
  assert.ok(types.includes('LTXAVTextEncoderLoader'),  'LTXAVTextEncoderLoader');
  assert.ok(types.includes('CLIPTextEncode'),          'CLIPTextEncode');
  assert.ok(types.includes('LTXVConditioning'),        'LTXVConditioning');
  assert.ok(types.includes('EmptyLTXVLatentVideo'),    'EmptyLTXVLatentVideo');
  assert.ok(types.includes('ModelSamplingLTXV'),       'ModelSamplingLTXV');
  assert.ok(types.includes('KSampler'),                'KSampler');
  assert.ok(types.includes('VAEDecode'),               'VAEDecode');
  assert.ok(types.includes('CreateVideo'),             'CreateVideo');
  assert.ok(types.includes('SaveVideo'),               'SaveVideo');
});

test('ltxvideo T2V: no LoadImage or LTXVAddGuide', () => {
  const types = nodeTypes(build(BASE));
  assert.ok(!types.includes('LoadImage'));
  assert.ok(!types.includes('LTXVAddGuide'));
});

test('ltxvideo I2V: includes LoadImage and LTXVAddGuide', () => {
  const wf = build({ ...BASE, inputRef: { filename: 'img.png', subfolder: '' }, isI2V: true });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LoadImage'),     'LoadImage');
  assert.ok(types.includes('LTXVAddGuide'),  'LTXVAddGuide');
});

test('ltxvideo T2V: default dimensions applied', () => {
  const wf = build(BASE);
  const latent = Object.values(wf).find(n => n.class_type === 'EmptyLTXVLatentVideo');
  assert.equal(latent.inputs.width,  defaults.width);
  assert.equal(latent.inputs.height, defaults.height);
  // 97 is already valid (1 + 12×8)
  assert.equal(latent.inputs.length, 97);
});

test('ltxvideo T2V: frames snapped to nearest valid 1+N×8 value', () => {
  // 118 is invalid; nearest valid is 121 (1+15×8)
  const wf = build({ ...BASE, frames: 118 });
  const latent = Object.values(wf).find(n => n.class_type === 'EmptyLTXVLatentVideo');
  assert.equal(latent.inputs.length, 121);
  // 113 is already valid (1+14×8)
  const wf2 = build({ ...BASE, frames: 113 });
  const latent2 = Object.values(wf2).find(n => n.class_type === 'EmptyLTXVLatentVideo');
  assert.equal(latent2.inputs.length, 113);
});

test('ltxvideo T2V: CreateVideo uses fps', () => {
  const wf = build({ ...BASE, fps: 30 });
  const cv = Object.values(wf).find(n => n.class_type === 'CreateVideo');
  assert.equal(cv.inputs.fps, 30);
});

test('ltxvideo T2V: no audio nodes without enableAudio', () => {
  const types = nodeTypes(build(BASE));
  assert.ok(!types.includes('LTXVAudioVAELoader'));
  assert.ok(!types.includes('LTXVEmptyLatentAudio'));
  assert.ok(!types.includes('LTXVConcatAVLatent'));
  assert.ok(!types.includes('LTXVSeparateAVLatent'));
  assert.ok(!types.includes('LTXVAudioVAEDecode'));
  assert.ok(!types.includes('SaveAudio'));
});

test('ltxvideo T2V with audio: includes all audio nodes', () => {
  const wf = build({ ...BASE, enableAudio: true });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LTXVAudioVAELoader'),   'LTXVAudioVAELoader');
  assert.ok(types.includes('LTXVEmptyLatentAudio'), 'LTXVEmptyLatentAudio');
  assert.ok(types.includes('LTXVConcatAVLatent'),   'LTXVConcatAVLatent');
  assert.ok(types.includes('LTXVSeparateAVLatent'), 'LTXVSeparateAVLatent');
  assert.ok(types.includes('LTXVAudioVAEDecode'),   'LTXVAudioVAEDecode');
  assert.ok(!types.includes('SaveAudio'),            'no separate SaveAudio — audio goes into CreateVideo');
});

test('ltxvideo T2V with audio: audio VAE loader uses same checkpoint', () => {
  const wf = build({ ...BASE, enableAudio: true });
  const loader = Object.values(wf).find(n => n.class_type === 'LTXVAudioVAELoader');
  assert.equal(loader.inputs.ckpt_name, BASE.checkpoint);
});

test('ltxvideo T2V with audio: decoded audio wired into CreateVideo', () => {
  const wf = build({ ...BASE, enableAudio: true });
  const create = Object.values(wf).find(n => n.class_type === 'CreateVideo');
  assert.ok(create.inputs.audio, 'CreateVideo has audio input');
});

test('ltxvideo T2V without audio: CreateVideo has no audio input', () => {
  const wf = build(BASE);
  const create = Object.values(wf).find(n => n.class_type === 'CreateVideo');
  assert.ok(!create.inputs.audio, 'CreateVideo has no audio input without enableAudio');
});

test('ltxvideo T2V: no LTX2LoraLoaderAdvanced without distilledLoraName', () => {
  assert.ok(!nodeTypes(build(BASE)).includes('LTX2LoraLoaderAdvanced'));
});

test('ltxvideo T2V: distilled LoRA injected when distilledLoraName set', () => {
  const wf = build({ ...BASE, distilledLoraName: 'ltx-2.3-22b-distilled-lora-384.safetensors' });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LTX2LoraLoaderAdvanced'), 'LTX2LoraLoaderAdvanced');
  const lora = Object.values(wf).find(n => n.class_type === 'LTX2LoraLoaderAdvanced');
  assert.equal(lora.inputs.lora_name, 'ltx-2.3-22b-distilled-lora-384.safetensors');
});

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/anima');

const BASE = {
  unetName: 'anima.safetensors',
  clipL:    'qwen_3_06b.safetensors',
  vaeName:  'qwen_image_vae.safetensors',
  positivePrompt: 'a knight on a hill',
};

const find    = (wf, type) => Object.values(wf).filter(n => n.class_type === type);
const sampler = wf => find(wf, 'KSampler')[0];

test('base graph: loaders, encodes, sampler wired to UNet and CLIP directly', () => {
  const wf = build(BASE);
  assert.equal(find(wf, 'LoraLoader').length, 0);
  assert.deepEqual(sampler(wf).inputs.model, ['1', 0]);
  const encodes = find(wf, 'CLIPTextEncode');
  assert.deepEqual(encodes[0].inputs.clip, ['2', 0]);
});

test('loras: chain threads model AND clip through each LoraLoader', () => {
  const wf = build({ ...BASE, loras: [
    { name: 'turbo.safetensors',  weight: 1.0 },
    { name: 'detail.safetensors', weight: 0.6 },
  ]});
  const loras = find(wf, 'LoraLoader');
  assert.equal(loras.length, 2);

  // First lora hangs off the loaders
  assert.deepEqual(wf['30'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['30'].inputs.clip,  ['2', 0]);
  assert.equal(wf['30'].inputs.lora_name, 'turbo.safetensors');
  assert.equal(wf['30'].inputs.strength_model, 1.0);
  // Second chains off the first
  assert.deepEqual(wf['31'].inputs.model, ['30', 0]);
  assert.deepEqual(wf['31'].inputs.clip,  ['30', 1]);
  assert.equal(wf['31'].inputs.strength_clip, 0.6);

  // Sampler model and text encodes hang off the LAST lora
  assert.deepEqual(sampler(wf).inputs.model, ['31', 0]);
  for (const enc of find(wf, 'CLIPTextEncode')) {
    assert.deepEqual(enc.inputs.clip, ['31', 1]);
  }
});

test('loras + ipadapter: adapter chain starts from the last lora model output', () => {
  const wf = build({ ...BASE,
    loras: [{ name: 'turbo.safetensors', weight: 1.0 }],
    adapterModel: 'anima_ipa.safetensors',
    ipAdapterImages: [{ filename: 'ref.png', subfolder: '' }],
  });
  assert.deepEqual(wf['53'].inputs.model, ['30', 0], 'AnimaIPAdapterApply model input');
  assert.deepEqual(sampler(wf).inputs.model, ['53', 0]);
});

test('lora weight defaults to 1.0 when omitted', () => {
  const wf = build({ ...BASE, loras: [{ name: 'x.safetensors' }] });
  assert.equal(wf['30'].inputs.strength_model, 1.0);
  assert.equal(wf['30'].inputs.strength_clip, 1.0);
});

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/chroma');

const BASE = {
  unetName: 'chroma.safetensors',
  clipName: 't5xxl.safetensors',
  vaeName:  'ae.safetensors',
  positivePrompt: 'a knight',
};

test('base graph unchanged without loras', () => {
  const wf = build(BASE);
  assert.equal(Object.values(wf).filter(n => n.class_type === 'LoraLoader').length, 0);
  assert.deepEqual(wf['4'].inputs.model, ['1', 0], 'ModelSamplingAuraFlow off the UNet');
  assert.deepEqual(wf['5'].inputs.clip,  ['2', 0], 'T5TokenizerOptions off the CLIP loader');
});

test('loras: chain sits between loaders and ModelSampling/tokenizer', () => {
  const wf = build({ ...BASE, loras: [
    { name: 'a.safetensors', weight: 0.7 },
    { name: 'b.safetensors', weight: 1.0 },
  ]});
  assert.deepEqual(wf['30'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['30'].inputs.clip,  ['2', 0]);
  assert.deepEqual(wf['31'].inputs.model, ['30', 0]);
  assert.deepEqual(wf['4'].inputs.model, ['31', 0], 'ModelSamplingAuraFlow patches the post-lora model');
  assert.deepEqual(wf['5'].inputs.clip,  ['31', 1], 'tokenizer reads the post-lora clip');
});

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/sd15');

const BASE = { checkpoint: 'sd15.safetensors', positivePrompt: 'a knight' };
const find = (wf, type) => Object.values(wf).filter(n => n.class_type === type);

test('base graph unchanged without loras', () => {
  const wf = build(BASE);
  assert.equal(find(wf, 'LoraLoader').length, 0);
  // KSampler should reference the checkpoint model output directly
  assert.deepEqual(wf['5'].inputs.model, ['1', 0]);
  // text encodes should reference the checkpoint clip output directly
  assert.deepEqual(wf['2'].inputs.clip,  ['1', 1]);
});

test('loras: chain threads model and clip; encodes + sampler hang off last link', () => {
  const wf = build({ ...BASE, loras: [
    { name: 'a.safetensors', weight: 0.7 },
    { name: 'b.safetensors', weight: 1.0 },
  ]});
  assert.deepEqual(wf['30'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['30'].inputs.clip,  ['1', 1]);
  assert.deepEqual(wf['31'].inputs.model, ['30', 0]);
  assert.deepEqual(wf['2'].inputs.clip,  ['31', 1]);
  assert.deepEqual(wf['3'].inputs.clip,  ['31', 1]);
  assert.deepEqual(wf['5'].inputs.model, ['31', 0]);
});

test('loras + ipadapter: unified loader patches the post-lora model', () => {
  const wf = build({ ...BASE,
    loras: [{ name: 'a.safetensors', weight: 1.0 }],
    adapterModel: 'ip-adapter_sd15.safetensors',
    ipAdapterImages: [{ filename: 'ref.png', subfolder: '' }],
  });
  assert.deepEqual(wf['50'].inputs.model, ['30', 0]);
  assert.deepEqual(wf['52'].inputs.model, ['50', 0]);
  assert.deepEqual(wf['5'].inputs.model,  ['52', 0]);
});

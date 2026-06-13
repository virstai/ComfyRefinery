'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/flux2');

const BASE = {
  unetName: 'flux2.safetensors', clipName: 'mistral3.safetensors',
  vaeName: 'ae.safetensors', positivePrompt: 'a knight',
};
const find = (wf, type) => Object.entries(wf).filter(([, n]) => n.class_type === type);

test('base graph without loras: sampler and encode wired to loaders', () => {
  const wf = build(BASE);
  assert.equal(find(wf, 'LoraLoader').length, 0);
  const [, samp] = find(wf, 'KSampler')[0];
  assert.deepEqual(samp.inputs.model, ['1', 0]);
  const [, enc] = find(wf, 'CLIPTextEncode')[0];
  assert.deepEqual(enc.inputs.clip, ['2', 0]);
});

test('loras: chain threads into encode and sampler', () => {
  const wf = build({ ...BASE, loras: [{ name: 'a.safetensors', weight: 0.6 }] });
  const [loraId, lora] = find(wf, 'LoraLoader')[0];
  assert.deepEqual(lora.inputs.model, ['1', 0]);
  assert.deepEqual(lora.inputs.clip,  ['2', 0]);
  assert.equal(lora.inputs.strength_model, 0.6);
  const [, enc]  = find(wf, 'CLIPTextEncode')[0];
  const [, samp] = find(wf, 'KSampler')[0];
  assert.deepEqual(enc.inputs.clip,   [loraId, 1]);
  assert.deepEqual(samp.inputs.model, [loraId, 0]);
});

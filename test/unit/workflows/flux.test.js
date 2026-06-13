'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/flux');

const SPLIT = {
  unetName: 'flux1-dev.safetensors', clipL: 'clip_l.safetensors',
  t5xxl: 't5xxl.safetensors', vaeName: 'ae.safetensors',
  positivePrompt: 'a knight',
};
const find = (wf, type) => Object.entries(wf).filter(([, n]) => n.class_type === type);

test('split mode without loras: guider and encode wired to loaders', () => {
  const wf = build(SPLIT);
  assert.equal(find(wf, 'LoraLoader').length, 0);
  const [, guider] = find(wf, 'BasicGuider')[0];
  assert.deepEqual(guider.inputs.model, ['1', 0]);
  const [, enc] = find(wf, 'CLIPTextEncode')[0];
  assert.deepEqual(enc.inputs.clip, ['2', 0]);
});

test('split mode with loras: chain threads into guider, scheduler, and encode', () => {
  const wf = build({ ...SPLIT, loras: [
    { name: 'a.safetensors', weight: 0.7 },
    { name: 'b.safetensors', weight: 1.0 },
  ]});
  const loras = find(wf, 'LoraLoader');
  assert.equal(loras.length, 2);
  const [firstId, first]   = loras[0];
  const [secondId, second] = loras[1];
  assert.deepEqual(first.inputs.model,  ['1', 0]);
  assert.deepEqual(first.inputs.clip,   ['2', 0]);
  assert.deepEqual(second.inputs.model, [firstId, 0]);
  assert.deepEqual(second.inputs.clip,  [firstId, 1]);

  const [, guider] = find(wf, 'BasicGuider')[0];
  const [, sched]  = find(wf, 'BasicScheduler')[0];
  const [, enc]    = find(wf, 'CLIPTextEncode')[0];
  assert.deepEqual(guider.inputs.model, [secondId, 0]);
  assert.deepEqual(sched.inputs.model,  [secondId, 0]);
  assert.deepEqual(enc.inputs.clip,     [secondId, 1]);
});

test('checkpoint mode with loras: chain hangs off the checkpoint loader', () => {
  const wf = build({ checkpoint: 'flux.safetensors', positivePrompt: 'a knight',
    loras: [{ name: 'a.safetensors', weight: 1.0 }] });
  const [, lora] = find(wf, 'LoraLoader')[0];
  assert.deepEqual(lora.inputs.model, ['1', 0]);
  assert.deepEqual(lora.inputs.clip,  ['1', 1]);
});

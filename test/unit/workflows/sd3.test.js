'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/sd3');

const BASE = { checkpoint: 'sd3.safetensors', positivePrompt: 'a knight' };

test('base graph unchanged without loras', () => {
  const wf = build(BASE);
  assert.equal(Object.values(wf).filter(n => n.class_type === 'LoraLoader').length, 0);
  assert.deepEqual(wf['5'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['2'].inputs.clip,  ['1', 1]);
});

test('loras: encodes and sampler hang off the chain', () => {
  const wf = build({ ...BASE, loras: [{ name: 'a.safetensors', weight: 0.8 }] });
  assert.deepEqual(wf['30'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['30'].inputs.clip,  ['1', 1]);
  assert.deepEqual(wf['2'].inputs.clip,  ['30', 1]);
  assert.deepEqual(wf['3'].inputs.clip,  ['30', 1]);
  assert.deepEqual(wf['5'].inputs.model, ['30', 0]);
});

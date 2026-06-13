'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { applyLoraChain } = require('../../../src/workflows/lib/loraChain');

test('no loras: refs unchanged, no nodes added', () => {
  const nodes = {};
  const out = applyLoraChain(nodes, ['1', 0], ['2', 0], undefined);
  assert.deepEqual(out, { modelRef: ['1', 0], clipRef: ['2', 0] });
  assert.equal(Object.keys(nodes).length, 0);
  const out2 = applyLoraChain(nodes, ['1', 0], ['2', 0], []);
  assert.deepEqual(out2, { modelRef: ['1', 0], clipRef: ['2', 0] });
});

test('chain threads model and clip; default ids 30+', () => {
  const nodes = {};
  const out = applyLoraChain(nodes, ['1', 0], ['2', 0], [
    { name: 'a.safetensors', weight: 0.7 },
    { name: 'b.safetensors' },
  ]);
  assert.equal(nodes['30'].class_type, 'LoraLoader');
  assert.deepEqual(nodes['30'].inputs.model, ['1', 0]);
  assert.deepEqual(nodes['30'].inputs.clip,  ['2', 0]);
  assert.equal(nodes['30'].inputs.lora_name, 'a.safetensors');
  assert.equal(nodes['30'].inputs.strength_model, 0.7);
  assert.equal(nodes['30'].inputs.strength_clip,  0.7);
  // second link chains off the first; missing weight defaults to 1.0
  assert.deepEqual(nodes['31'].inputs.model, ['30', 0]);
  assert.deepEqual(nodes['31'].inputs.clip,  ['30', 1]);
  assert.equal(nodes['31'].inputs.strength_model, 1.0);
  assert.deepEqual(out, { modelRef: ['31', 0], clipRef: ['31', 1] });
});

test('custom makeId allocator', () => {
  const nodes = { '1': {}, '2': {} };
  let c = 2;
  const out = applyLoraChain(nodes, ['1', 0], ['2', 0],
    [{ name: 'a.safetensors', weight: 1.0 }], () => String(++c));
  assert.equal(nodes['3'].class_type, 'LoraLoader');
  assert.deepEqual(out.modelRef, ['3', 0]);
});

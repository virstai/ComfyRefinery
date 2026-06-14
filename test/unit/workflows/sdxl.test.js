'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build } = require('../../../src/workflows/sdxl');

const BASE = { checkpoint: 'sdxl.safetensors', positivePrompt: 'a knight' };
const find = (wf, type) => Object.values(wf).filter(n => n.class_type === type);

test('base graph unchanged without loras', () => {
  const wf = build(BASE);
  assert.equal(find(wf, 'LoraLoader').length, 0);
  assert.deepEqual(wf['5'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['2'].inputs.clip,  ['1', 1]);
});

test('loras: encodes and base sampler hang off the chain', () => {
  const wf = build({ ...BASE, loras: [{ name: 'a.safetensors', weight: 0.5 }] });
  assert.deepEqual(wf['30'].inputs.model, ['1', 0]);
  assert.deepEqual(wf['30'].inputs.clip,  ['1', 1]);
  assert.equal(wf['30'].inputs.strength_model, 0.5);
  assert.deepEqual(wf['2'].inputs.clip,  ['30', 1]);
  assert.deepEqual(wf['3'].inputs.clip,  ['30', 1]);
  assert.deepEqual(wf['5'].inputs.model, ['30', 0]);
});

test('loras + refiner: lora applies to the base pass only', () => {
  const wf = build({ ...BASE,
    loras: [{ name: 'a.safetensors', weight: 1.0 }],
    refinerCheckpoint: 'sdxl_refiner.safetensors',
  });
  assert.deepEqual(wf['5'].inputs.model,  ['30', 0], 'base sampler post-lora');
  assert.deepEqual(wf['13'].inputs.model, ['10', 0], 'refiner sampler untouched');
  assert.deepEqual(wf['11'].inputs.clip,  ['10', 1], 'refiner encodes untouched');
});

test('loras + ipadapter: unified loader patches the post-lora model', () => {
  const wf = build({ ...BASE,
    loras: [{ name: 'a.safetensors', weight: 1.0 }],
    adapterModel: 'ip-adapter_sdxl.safetensors',
    ipAdapterImages: [{ filename: 'ref.png', subfolder: '' }],
  });
  assert.deepEqual(wf['50'].inputs.model, ['30', 0]);
  assert.deepEqual(wf['5'].inputs.model,  ['52', 0]);
});

test('tile controlnet: nodes 60/61/62 present, image is rescaled, end_percent is 0.85', () => {
  const wf = build({ ...BASE,
    tileControlNet: { image: { filename: 'tile.png', subfolder: '' }, model: 'cn-tile.safetensors', strength: 0.7 },
  });
  assert.ok(wf['60'],  'LoadImage present');
  assert.ok(wf['60r'], 'ImageScale present');
  assert.ok(wf['61'],  'ControlNetLoader present');
  assert.ok(wf['62'],  'ControlNetApplyAdvanced present');
  assert.equal(wf['62'].inputs.end_percent, 0.85);
  assert.equal(wf['62'].inputs.strength, 0.7);
  // Positive/negative conditioning are replaced by the CN outputs
  assert.deepEqual(wf['5'].inputs.positive, ['62', 0]);
  assert.deepEqual(wf['5'].inputs.negative, ['62', 1]);
});

test('tile controlnet without a tile image: no CN nodes emitted', () => {
  const wf = build({ ...BASE, tileControlNet: { model: 'cn-tile.safetensors' } });
  assert.ok(!wf['62'], 'no ControlNetApplyAdvanced when image is missing');
});

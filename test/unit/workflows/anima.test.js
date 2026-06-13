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

test('controlNet: LLLite node patches model between loras and sampler', () => {
  const wf = build({ ...BASE,
    loras: [{ name: 'turbo.safetensors', weight: 1.0 }],
    controlNet: { image: { filename: 'pose.png', subfolder: '' }, model: 'anima_lllite_pose.safetensors', strength: 0.8 },
  });
  const load = wf['70'];
  assert.equal(load.class_type, 'LoadImage');
  assert.equal(load.inputs.image, 'pose.png');

  const lllite = wf['71'];
  assert.equal(lllite.class_type, 'AnimaLLLiteApply');
  assert.deepEqual(lllite.inputs.model, ['30', 0], 'patches the post-lora model');
  assert.equal(lllite.inputs.lllite_name, 'anima_lllite_pose.safetensors');
  assert.deepEqual(lllite.inputs.image, ['70', 0]);
  assert.equal(lllite.inputs.strength, 0.8);
  assert.equal(lllite.inputs.preserve_wrapper, true);

  assert.deepEqual(sampler(wf).inputs.model, ['71', 0]);
});

test('controlNet with subfolder image path', () => {
  const wf = build({ ...BASE,
    controlNet: { image: { filename: 'pose.png', subfolder: 'poses' }, model: 'lllite.safetensors' },
  });
  assert.equal(wf['70'].inputs.image, 'poses/pose.png');
  assert.equal(wf['71'].inputs.strength, 1.0, 'default strength');
});

test('controlNet ignored when image or model missing', () => {
  const a = build({ ...BASE, controlNet: { model: 'lllite.safetensors' } });
  const b = build({ ...BASE, controlNet: { image: { filename: 'pose.png' } } });
  assert.equal(a['71'], undefined);
  assert.equal(b['71'], undefined);
});

test('controlNet + ipadapter: adapter chains off the LLLite-patched model', () => {
  const wf = build({ ...BASE,
    controlNet: { image: { filename: 'pose.png', subfolder: '' }, model: 'lllite.safetensors' },
    adapterModel: 'anima_ipa.safetensors',
    ipAdapterImages: [{ filename: 'ref.png', subfolder: '' }],
  });
  assert.deepEqual(wf['53'].inputs.model, ['71', 0]);
});

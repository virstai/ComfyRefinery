'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { archMeta, architectures } = require('../../../src/workflows');

test('every architecture declares boolean lora/adapter/controlNet capabilities', () => {
  for (const arch of architectures) {
    const caps = archMeta[arch]?.capabilities;
    assert.ok(caps, `${arch} is missing capabilities`);
    for (const key of ['lora', 'adapter', 'controlNet']) {
      assert.equal(typeof caps[key], 'boolean', `${arch}.capabilities.${key} must be boolean`);
    }
  }
});

test('image archs support lora; video archs support nothing', () => {
  for (const arch of ['sd15', 'sdxl', 'flux', 'flux2', 'sd3', 'chroma', 'anima']) {
    assert.equal(archMeta[arch].capabilities.lora, true, `${arch} lora`);
  }
  for (const arch of ['wanvideo', 'hunyuanvideo', 'ltxvideo', 'cogvideox']) {
    assert.deepEqual(archMeta[arch].capabilities, { lora: false, adapter: false, controlNet: false }, arch);
  }
});

test('adapter: enabled for sd15/sdxl/flux/flux2, disabled for sd3/chroma and anima (weights unreleased)', () => {
  for (const arch of ['sd15', 'sdxl', 'flux', 'flux2']) {
    assert.equal(archMeta[arch].capabilities.adapter, true, arch);
  }
  for (const arch of ['sd3', 'chroma', 'anima']) {
    assert.equal(archMeta[arch].capabilities.adapter, false, arch);
  }
});

test('controlNet: anima only', () => {
  for (const arch of architectures) {
    assert.equal(archMeta[arch].capabilities.controlNet, arch === 'anima', arch);
  }
});

test('anima declares the negativePrompt field (drives the workflow editor)', () => {
  assert.equal(archMeta.anima.fields.negativePrompt, true);
});

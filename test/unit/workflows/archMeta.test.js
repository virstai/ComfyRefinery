'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { archMeta, architectures, filmFormats, getDefaults } = require('../../../src/workflows');

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
  for (const arch of ['sd15', 'sdxl', 'flux', 'flux2', 'sd3', 'chroma', 'anima', 'zimage', 'krea2']) {
    assert.equal(archMeta[arch].capabilities.lora, true, `${arch} lora`);
  }
  for (const arch of ['wanvideo', 'hunyuanvideo', 'cogvideox']) {
    assert.deepEqual(archMeta[arch].capabilities, { lora: false, adapter: false, controlNet: false }, arch);
  }
  // LTX-2.3 takes DiT-only LoRAs (the distilled LoRA is one; Sulphur 2 ships as one too)
  assert.deepEqual(archMeta.ltxvideo.capabilities, { lora: true, adapter: false, controlNet: false });
});

test('adapter: enabled for sd15/sdxl/flux/flux2, disabled for sd3/chroma and anima (weights unreleased)', () => {
  for (const arch of ['sd15', 'sdxl', 'flux', 'flux2']) {
    assert.equal(archMeta[arch].capabilities.adapter, true, arch);
  }
  for (const arch of ['sd3', 'chroma', 'anima', 'zimage', 'krea2']) {
    assert.equal(archMeta[arch].capabilities.adapter, false, arch);
  }
});

test('controlNet (pose pre-pass): sd15, sdxl, anima; tileControlNet + structuralControlNet: sd15 and sdxl only', () => {
  const poseSupported = ['sd15', 'sdxl', 'anima'];
  for (const arch of architectures) {
    assert.equal(archMeta[arch].capabilities.controlNet, poseSupported.includes(arch), arch);
  }
  // Tile and structural CN are available on sd15/sdxl only
  for (const arch of ['sd15', 'sdxl']) {
    assert.equal(archMeta[arch].capabilities.tileControlNet,       true, `${arch} tileControlNet`);
    assert.equal(archMeta[arch].capabilities.structuralControlNet, true, `${arch} structuralControlNet`);
  }
  for (const arch of ['flux', 'flux2', 'anima', 'sd3', 'chroma', 'zimage', 'krea2']) {
    assert.equal(archMeta[arch].capabilities.tileControlNet,       undefined, `${arch} no tileControlNet`);
    assert.equal(archMeta[arch].capabilities.structuralControlNet, undefined, `${arch} no structuralControlNet`);
  }
});

test('anima declares the negativePrompt field (drives the workflow editor)', () => {
  assert.equal(archMeta.anima.fields.negativePrompt, true);
});

test('minimaxh3 declares its Film / reference-media abilities; no other arch is Film-eligible', () => {
  const h3 = archMeta.minimaxh3;
  assert.deepEqual(h3.capabilities, { lora: true, adapter: false, controlNet: false }, 'H3 takes DiT LoRAs');
  assert.equal(h3.lastFrame, true);
  assert.equal(h3.referenceVideos, 3);
  assert.equal(h3.referenceAudios, 3);
  assert.deepEqual(h3.referenceToVideoRequires, ['refUnetName', 'audioVaeName']);
  assert.equal(h3.film, true);
  assert.equal(h3.filmFrames, 124);
  for (const arch of Object.keys(archMeta)) {
    if (!['minimaxh3', 'ltxvideo'].includes(arch)) assert.equal(archMeta[arch].film, undefined, `${arch} must not declare film`);
  }
});

test('ltxvideo: Film-eligible (continue only), /64 grid, distilled/full sampling, negative prompt, latent upscaler field', () => {
  const ltx = archMeta.ltxvideo;
  assert.equal(ltx.film, true);
  assert.equal(ltx.filmFrames, 121);
  assert.equal(ltx.referenceToVideo, undefined, 'no cut mode');
  assert.equal(ltx.dimMultiple, 64);
  assert.equal(ltx.fields.negativePrompt, true);
  assert.equal(ltx.fields.upscaleModel, 'latentUpscale');
  assert.deepEqual(ltx.fields.samplingMode, ['distilled', 'full']);
  const list = filmFormats('ltxvideo');
  assert.deepEqual({ width: list[0].width, height: list[0].height }, { width: 1024, height: 576 });
  for (const f of list) {
    assert.equal(f.width % 64, 0, `${f.label} width on /64`);
    assert.equal(f.height % 64, 0, `${f.label} height on /64`);
  }
  for (const o of ['landscape', 'portrait', 'square']) assert.ok(list.some(f => f.orientation === o), o);
  assert.equal(new Set(list.map(f => `${f.width}x${f.height}`)).size, list.length);
});

test('filmFormats(minimaxh3): explicit presets on the /32 grid, short edge ≤ 768, both orientations, native first', () => {
  const list = filmFormats('minimaxh3');
  assert.ok(list.length >= 6);
  assert.deepEqual({ width: list[0].width, height: list[0].height, aspect: list[0].aspect }, { width: 1344, height: 768, aspect: '16:9' });
  assert.equal(list[0].label, '16:9 · 1344×768 (native)');
  for (const f of list) {
    assert.equal(f.width % 32, 0, `${f.label} width on /32`);
    assert.equal(f.height % 32, 0, `${f.label} height on /32`);
    assert.ok(Math.min(f.width, f.height) <= 768, `${f.label} short edge within the 768p cap`);
    assert.match(f.aspect, /^\d+:\d+$/);
    assert.equal(f.orientation, f.width === f.height ? 'square' : f.width > f.height ? 'landscape' : 'portrait');
  }
  const orientations = new Set(list.map(f => f.orientation));
  assert.ok(orientations.has('landscape') && orientations.has('portrait') && orientations.has('square'));
  // the ROCm-clean size is offered in both orientations
  assert.ok(list.some(f => f.width === 1024 && f.height === 576));
  assert.ok(list.some(f => f.width === 576 && f.height === 1024));
  // no duplicate sizes
  assert.equal(new Set(list.map(f => `${f.width}x${f.height}`)).size, list.length);
});

test('filmFormats(): archs without an explicit list get standard aspects fitted to their default budget and grid', () => {
  const list = filmFormats('wanvideo');
  const d = getDefaults('wanvideo');
  const mult = archMeta.wanvideo.dimMultiple;
  assert.ok(list.length >= 6);
  for (const f of list) {
    assert.equal(f.width % mult, 0, `${f.label} width on /${mult}`);
    assert.equal(f.height % mult, 0, `${f.label} height on /${mult}`);
    assert.ok(Math.max(f.width, f.height) <= Math.max(d.width, d.height) + mult / 2, `${f.label} long edge capped`);
    assert.ok(Math.min(f.width, f.height) <= Math.min(d.width, d.height) + mult / 2, `${f.label} short edge capped`);
    assert.ok(f.label.startsWith(`${f.aspect} · ${f.width}×${f.height}`));
  }
  assert.ok(list.some(f => f.orientation === 'landscape') && list.some(f => f.orientation === 'portrait') && list.some(f => f.orientation === 'square'));
});

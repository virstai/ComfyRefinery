'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

test('all 4 video archs are in archMeta with videoArch: true', () => {
  const { archMeta } = require('../../src/workflows');
  for (const arch of ['wanvideo', 'hunyuanvideo', 'ltxvideo', 'cogvideox']) {
    assert.ok(archMeta[arch], `${arch} present in archMeta`);
    assert.equal(archMeta[arch].videoArch, true, `${arch}.videoArch is true`);
    assert.ok(archMeta[arch].label,        `${arch} has a label`);
    assert.ok(archMeta[arch].fields,       `${arch} has fields`);
  }
});

test('video archs each have defaults', () => {
  const { getDefaults } = require('../../src/workflows');
  for (const arch of ['wanvideo', 'hunyuanvideo', 'ltxvideo', 'cogvideox']) {
    const d = getDefaults(arch);
    assert.ok(d.frames, `${arch} defaults has frames`);
    assert.ok(d.fps,    `${arch} defaults has fps`);
    assert.ok(d.steps,  `${arch} defaults has steps`);
  }
});

test('image archs do not have videoArch flag', () => {
  const { archMeta } = require('../../src/workflows');
  for (const arch of ['sd15', 'sdxl', 'flux', 'flux2', 'sd3', 'chroma', 'anima']) {
    assert.ok(!archMeta[arch]?.videoArch, `${arch} should not have videoArch`);
  }
});

test('video step type is registered', () => {
  const steps = require('../../src/steps');
  const step  = steps.get('video');
  assert.ok(step, 'video step registered');
  assert.equal(typeof step.label,              'function', 'has label');
  assert.equal(typeof step.prepare,            'function', 'has prepare');
  assert.equal(typeof step.buildComfyWorkflow, 'function', 'has buildComfyWorkflow');
});

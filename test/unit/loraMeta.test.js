'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { detectArchitecture } = require('../../src/lib/loraMeta');

test('detects sd15 from ss_base_model_version sd_v1', () => {
  assert.equal(detectArchitecture({ ss_base_model_version: 'sd_v1' }), 'sd15');
});

test('detects sd15 from sd_v2 (SD2 shares the sd15 arch)', () => {
  assert.equal(detectArchitecture({ ss_base_model_version: 'sd_v2_768_v' }), 'sd15');
});

test('detects sdxl from ss_base_model_version', () => {
  assert.equal(detectArchitecture({ ss_base_model_version: 'sdxl_base_v1-0' }), 'sdxl');
});

test('detects sd3 / flux / flux2 / anima / chroma', () => {
  assert.equal(detectArchitecture({ ss_base_model_version: 'sd3_m' }),    'sd3');
  assert.equal(detectArchitecture({ ss_base_model_version: 'flux1' }),    'flux');
  assert.equal(detectArchitecture({ ss_base_model_version: 'flux2' }),    'flux2');
  assert.equal(detectArchitecture({ ss_base_model_version: 'anima_v1' }), 'anima');
  assert.equal(detectArchitecture({ ss_base_model_version: 'chroma' }),   'chroma');
});

test('falls back to modelspec.architecture', () => {
  assert.equal(detectArchitecture({ 'modelspec.architecture': 'stable-diffusion-xl-v1-base/lora' }), 'sdxl');
  assert.equal(detectArchitecture({ 'modelspec.architecture': 'flux-1-dev/lora' }), 'flux');
  assert.equal(detectArchitecture({ 'modelspec.architecture': 'anima/lora' }), 'anima');
});

test('ss_base_model_version wins over modelspec', () => {
  assert.equal(detectArchitecture({
    ss_base_model_version:    'sdxl_base_v1-0',
    'modelspec.architecture': 'flux-1-dev/lora',
  }), 'sdxl');
});

test('returns null for unknown, missing, or non-object metadata', () => {
  assert.equal(detectArchitecture({ ss_base_model_version: 'pony_v6' }), null);
  assert.equal(detectArchitecture({}), null);
  assert.equal(detectArchitecture(null), null);
  assert.equal(detectArchitecture('garbage'), null);
});

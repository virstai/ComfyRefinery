'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

// We only test pure functions (label, buildComfyWorkflow) as unit tests.
// prepare() makes HTTP calls — covered by the integration test (Task 9).

const video = require('../../../src/steps/video');

// ── label ─────────────────────────────────────────────────────────────────────

test('label: shows model label, frame count, and fps', () => {
  const cfg = {
    models: {
      'wanvideo-i2v': { label: 'WanVideo I2V', architecture: 'wanvideo' },
    },
  };
  const stepDef = { type: 'video', modelId: 'wanvideo-i2v', params: { frames: 49, fps: 16 } };
  const lbl = video.label(stepDef, cfg);
  assert.ok(lbl.includes('WanVideo I2V'), `label includes model label, got: ${lbl}`);
  assert.ok(lbl.includes('49'),           `label includes frame count, got: ${lbl}`);
  assert.ok(lbl.includes('16'),           `label includes fps, got: ${lbl}`);
});

test('label: falls back gracefully when model not in config', () => {
  const lbl = video.label({ type: 'video', modelId: 'missing', params: {} }, {});
  assert.ok(typeof lbl === 'string', 'returns a string');
});

// ── buildComfyWorkflow ────────────────────────────────────────────────────────

test('buildComfyWorkflow: routes to wanvideo builder for wanvideo arch', () => {
  const stepDef = {
    type: 'video', modelId: 'wanvideo-t2v',
    params: { frames: 49, fps: 16, steps: 30, guidance: 6, width: 832, height: 480 },
  };
  const modelConfig = {
    id: 'wanvideo-t2v', architecture: 'wanvideo',
    unetName: 'u.safetensors', vaeName: 'v.safetensors', clipName: 'c.safetensors',
  };
  const ctx = {
    cfg: { models: { 'wanvideo-t2v': modelConfig } },
    userPrompt: 'a river',
    modelConfig,
  };
  const wf = video.buildComfyWorkflow(stepDef, { inputRef: null, isI2V: false }, ctx);
  const types = Object.values(wf).map(n => n.class_type);
  assert.ok(types.includes('UNETLoader'), 'wanvideo builder was called');
  assert.ok(types.includes('CreateVideo'),         'CreateVideo output node present');
  assert.ok(types.includes('SaveVideo'),           'SaveVideo output node present');
});

test('buildComfyWorkflow: throws if arch is not a video arch', () => {
  const stepDef = { type: 'video', modelId: 'sd-model', params: {} };
  const ctx = {
    cfg: {},
    userPrompt: 'test',
    modelConfig: { id: 'sd-model', architecture: 'sd15', checkpoint: 'model.safetensors' },
  };
  assert.throws(
    () => video.buildComfyWorkflow(stepDef, { inputRef: null, isI2V: false }, ctx),
    /not a video architecture/,
  );
});

test('buildComfyWorkflow: throws if modelConfig not on ctx', () => {
  const stepDef = { type: 'video', modelId: 'x', params: {} };
  assert.throws(
    () => video.buildComfyWorkflow(stepDef, { inputRef: null, isI2V: false }, {}),
    /modelConfig/,
  );
});

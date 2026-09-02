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

// ── autoSize (I2V aspect-ratio follow) ───────────────────────────────────────

const MMX_MODEL = {
  id: 'h3', architecture: 'minimaxh3',
  unetName: 'fl2va.safetensors', clipName: 'clip.safetensors', vaeName: 'vae.safetensors',
};
const MMX_CTX = { cfg: { models: { h3: MMX_MODEL } }, userPrompt: 'a scene', modelConfig: MMX_MODEL };
const REF = { filename: 'in.png', subfolder: '', type: 'input' };

function h3Node(wf) {
  return Object.values(wf).find(n => n.class_type === 'MiniMaxH3ImageToVideo');
}

test('buildComfyWorkflow: prepare autoSize replaces arch default dimensions', () => {
  const wf = video.buildComfyWorkflow(
    { type: 'video', modelId: 'h3', params: {} },
    { inputRef: REF, isI2V: true, autoSize: { width: 768, height: 1344 } },
    MMX_CTX,
  );
  assert.equal(h3Node(wf).inputs.width, 768);
  assert.equal(h3Node(wf).inputs.height, 1344);
});

test('buildComfyWorkflow: explicit step params beat autoSize', () => {
  const wf = video.buildComfyWorkflow(
    { type: 'video', modelId: 'h3', params: { width: 1024, height: 1024 } },
    { inputRef: REF, isI2V: true, autoSize: { width: 768, height: 1344 } },
    MMX_CTX,
  );
  assert.equal(h3Node(wf).inputs.width, 1024);
  assert.equal(h3Node(wf).inputs.height, 1024);
});

test('buildComfyWorkflow: single-dimension autoSize fills the missing axis only', () => {
  const wf = video.buildComfyWorkflow(
    { type: 'video', modelId: 'h3', params: { width: 640 } },
    { inputRef: REF, isI2V: true, autoSize: { height: 928 } },
    MMX_CTX,
  );
  assert.equal(h3Node(wf).inputs.width, 640);
  assert.equal(h3Node(wf).inputs.height, 928);
});

// ── pickPrimaryVideo ─────────────────────────────────────────────────────────

test('pickPrimaryVideo prefers the muxed file over the _noaudio fallback', () => {
  const silent = { filename: 'iterator_video_noaudio_00003_.mp4' };
  const muxed  = { filename: 'iterator_video_00003_.mp4' };
  assert.equal(video.pickPrimaryVideo([silent, muxed]), muxed, 'execution order puts the fallback first');
  assert.equal(video.pickPrimaryVideo([silent]), silent, 'fallback alone is still a result');
  assert.equal(video.pickPrimaryVideo([]), null);
});

// ── steering ─────────────────────────────────────────────────────────────────

test('buildVideoMessages appends steering notes to the request, none when blank', () => {
  const withNotes = video.buildVideoMessages('a cat', 'minimaxh3', { isI2V: true, steering: ' Slow push-in. Sound: rain only. ' }, null);
  const user = withNotes.find(m => m.role === 'user').content;
  assert.match(user, /^Description: a cat/);
  assert.match(user, /Director's notes/);
  assert.match(user, /Slow push-in\. Sound: rain only\.$/);
  const without = video.buildVideoMessages('a cat', 'minimaxh3', { isI2V: true, steering: '   ' }, null);
  assert.equal(without.find(m => m.role === 'user').content, 'Description: a cat');
});

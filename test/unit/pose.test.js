'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { buildPoseGraph, DWPOSE_NODE } = require('../../src/services/pose');

const POSE_MODEL = {
  id: 'pose-draft', label: 'Pose Draft', architecture: 'sd15',
  checkpoint: 'fast.safetensors',
};

test('pose graph routes SaveImage through the DWPose preprocessor', () => {
  const wf = buildPoseGraph(POSE_MODEL, 'a knight on a hill', { width: 1024, height: 1024 });

  const dw = wf['90'];
  assert.equal(dw.class_type, DWPOSE_NODE);

  const save = Object.values(wf).find(n => n.class_type === 'SaveImage');
  assert.deepEqual(save.inputs.images, ['90', 0], 'SaveImage takes the skeleton, not the draft');

  // DWPose input is what SaveImage originally consumed (the VAEDecode output)
  const decode = Object.entries(wf).find(([, n]) => n.class_type === 'VAEDecode');
  assert.deepEqual(dw.inputs.image, [decode[0], 0]);
});

test('pose graph carries the prompt and dimensions', () => {
  const wf = buildPoseGraph(POSE_MODEL, 'a knight on a hill', { width: 768, height: 1152 });
  const positive = Object.values(wf).find(n => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'a knight on a hill');
  assert.ok(positive, 'prompt present in graph');
  const latent = Object.values(wf).find(n => n.class_type === 'EmptyLatentImage');
  assert.equal(latent.inputs.width, 768);
  assert.equal(latent.inputs.height, 1152);
});

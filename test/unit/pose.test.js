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

  const dw = wf['990'];
  assert.equal(dw.class_type, DWPOSE_NODE);

  const save = Object.values(wf).find(n => n.class_type === 'SaveImage');
  assert.deepEqual(save.inputs.images, ['990', 0], 'SaveImage takes the skeleton, not the draft');

  // DWPose input is what SaveImage originally consumed (the VAEDecode output)
  const decode = Object.entries(wf).find(([, n]) => n.class_type === 'VAEDecode');
  assert.deepEqual(dw.inputs.image, [decode[0], 0]);
});

test('draft prompt is detection-friendly: templated description, anti-crop negative', () => {
  const wf = buildPoseGraph(POSE_MODEL, 'a knight kneeling with sword planted', { width: 768, height: 1152 });

  const encodes  = Object.values(wf).filter(n => n.class_type === 'CLIPTextEncode');
  const positive = encodes.find(n => n.inputs.text.includes('a knight kneeling with sword planted'));
  assert.ok(positive, 'pose description present in the draft prompt');
  assert.match(positive.inputs.text, /entire body visible/, 'framing forced toward full body');
  assert.match(positive.inputs.text, /photorealistic/, 'rendering biased toward the photo-trained detector');
  assert.ok(!positive.inputs.text.includes('cel shading'), 'no style terms leak in');

  const negative = encodes.find(n => /close-up/.test(n.inputs.text));
  assert.ok(negative, 'negative prompt suppresses crops/close-ups');
  assert.match(negative.inputs.text, /cropped/);

  const latent = Object.values(wf).find(n => n.class_type === 'EmptyLatentImage');
  assert.equal(latent.inputs.width, 768);
  assert.equal(latent.inputs.height, 1152);
});

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { applyDevicePlacement, normalizeDevices, usesMultiGpuNodes } = require('../../../src/workflows/lib/devicePlacement');
const { buildWorkflow } = require('../../../src/workflows');

const find = (wf, type) => Object.values(wf).filter(n => n.class_type === type);

const FLUX2 = { id: 'k', architecture: 'flux2', unetName: 'u.safetensors', clipName: 'c.safetensors', vaeName: 'v.safetensors' };
const H3    = { id: 'h3', architecture: 'minimaxh3', unetName: 'h3.safetensors', clipName: 'q.safetensors',
                vaeName: 'video_vae.safetensors', audioVaeName: 'audio_vae.safetensors' };

test('auto / no devices leaves the native loaders untouched', () => {
  const { workflow } = buildWorkflow({ ...FLUX2, devices: { unet: 'auto', clip: 'auto' } }, { positivePrompt: 'x' });
  assert.equal(find(workflow, 'UNETLoader').length, 1);
  assert.equal(find(workflow, 'CLIPLoader').length, 1);
  assert.equal(find(workflow, 'VAELoader').length, 1);
  assert.equal(usesMultiGpuNodes(workflow), false);
});

test('placed components swap to their MultiGPU loaders with a device input, same file inputs', () => {
  const { workflow } = buildWorkflow({ ...FLUX2, devices: { clip: 'cuda:1', vae: 'cpu' } }, { positivePrompt: 'x' });
  const [clip] = find(workflow, 'CLIPLoaderMultiGPU');
  const [vae]  = find(workflow, 'VAELoaderMultiGPU');
  assert.ok(clip && vae);
  assert.equal(clip.inputs.device, 'cuda:1');
  assert.equal(clip.inputs.clip_name, 'c.safetensors');
  assert.equal(clip.inputs.type, 'flux2');
  assert.equal(vae.inputs.device, 'cpu');
  assert.equal(vae.inputs.vae_name, 'v.safetensors');
  assert.equal(find(workflow, 'UNETLoader').length, 1, 'unet stays native (auto)');
  assert.equal(find(workflow, 'CLIPLoader').length, 0);
  assert.equal(usesMultiGpuNodes(workflow), true);
  // consumers still reference the same node ids
  const [enc] = find(workflow, 'CLIPTextEncode');
  assert.equal(workflow[enc.inputs.clip[0]].class_type, 'CLIPLoaderMultiGPU');
});

test('the audio VAE is placed independently of the video VAE', () => {
  const { workflow } = buildWorkflow({ ...H3, devices: { audioVae: 'cuda:1' } }, { positivePrompt: 'x' });
  const placed = find(workflow, 'VAELoaderMultiGPU');
  assert.equal(placed.length, 1);
  assert.equal(placed[0].inputs.vae_name, 'audio_vae.safetensors');
  assert.equal(placed[0].inputs.device, 'cuda:1');
  const native = find(workflow, 'VAELoader');
  assert.equal(native.length, 1);
  assert.equal(native[0].inputs.vae_name, 'video_vae.safetensors');
});

test('checkpoint archs place the checkpoint loader under the unet role', () => {
  const sdxl = { id: 's', architecture: 'sdxl', checkpoint: 'x.safetensors', devices: { unet: 'cuda:0' } };
  const { workflow } = buildWorkflow(sdxl, { positivePrompt: 'x' });
  const [ckpt] = find(workflow, 'CheckpointLoaderSimpleMultiGPU');
  assert.ok(ckpt);
  assert.equal(ckpt.inputs.ckpt_name, 'x.safetensors');
  assert.equal(ckpt.inputs.device, 'cuda:0');
});

test('normalizeDevices drops auto, blanks and unknown roles', () => {
  assert.equal(normalizeDevices({ unet: 'auto', clip: '', bogus: 'cuda:1' }), null);
  assert.deepEqual(normalizeDevices({ unet: 'auto', vae: 'cuda:1', clip: 'cpu' }), { clip: 'cpu', vae: 'cuda:1' });
  assert.equal(normalizeDevices(undefined), null);
});

test('applyDevicePlacement is a no-op on graphs without loaders it knows', () => {
  const wf = { 1: { class_type: 'HunyuanVideoModelLoader', inputs: { model: 'x' } } };
  applyDevicePlacement(wf, { devices: { unet: 'cuda:1' } });
  assert.equal(wf[1].class_type, 'HunyuanVideoModelLoader');
});

test('ltxvideo: external video + audio VAEs are placed under their own roles; the checkpoint stays put', () => {
  const { buildWorkflow } = require('../../../src/workflows');
  const model = {
    id: 'ltx', architecture: 'ltxvideo', checkpoint: 'sulphur_dev_fp8mixed.safetensors', clipName: 'gemma.safetensors',
    distilledLoraName: 'distilled.safetensors', upscaleModel: 'up.safetensors', enableAudio: true,
    vae: 'ltx-2.3-video-vae.safetensors', audioVaeName: 'ltx-2.3-audio-vae.safetensors',
    devices: { vae: 'cuda:1', audioVae: 'cuda:1' },
  };
  const { workflow } = buildWorkflow(model, { positivePrompt: 'x' });
  const nodes = Object.values(workflow);
  const placed = nodes.filter(n => n.class_type === 'VAELoaderMultiGPU');
  assert.equal(placed.length, 2);
  for (const n of placed) assert.equal(n.inputs.device, 'cuda:1');
  assert.deepEqual(placed.map(n => n.inputs.vae_name).sort(), ['ltx-2.3-audio-vae.safetensors', 'ltx-2.3-video-vae.safetensors']);
  assert.ok(!nodes.some(n => n.class_type === 'VAELoader'), 'no native VAELoader left');
  assert.ok(nodes.some(n => n.class_type === 'CheckpointLoaderSimple'), 'checkpoint loader untouched without devices.unet');
});

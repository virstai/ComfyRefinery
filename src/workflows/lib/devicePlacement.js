'use strict';

// Per-component device placement via the ComfyUI-MultiGPU custom node pack.
//
// A model config may carry `devices: { unet, clip, vae, audioVae, clipVision,
// controlNet }` where each value is 'cpu' or a ComfyUI device id such as
// 'cuda:1' ('auto' / absent = the native loader, ComfyUI decides). This runs as
// a post-pass over any built graph: matching loader nodes are swapped for their
// MultiGPU twins, which take the same inputs plus `device`, so every arch
// builder gets placement for free and stays unaware of it.
//
// The main diffusion model normally stays on the compute GPU; the point is to
// move the text encoder / VAEs off it (to a second card or system RAM) so the
// UNet and its activations get the whole card.

const LOADERS = {
  UNETLoader:             { role: 'unet',       multi: 'UNETLoaderMultiGPU' },
  CheckpointLoaderSimple: { role: 'unet',       multi: 'CheckpointLoaderSimpleMultiGPU' },
  CLIPLoader:             { role: 'clip',       multi: 'CLIPLoaderMultiGPU' },
  DualCLIPLoader:         { role: 'clip',       multi: 'DualCLIPLoaderMultiGPU' },
  TripleCLIPLoader:       { role: 'clip',       multi: 'TripleCLIPLoaderMultiGPU' },
  QuadrupleCLIPLoader:    { role: 'clip',       multi: 'QuadrupleCLIPLoaderMultiGPU' },
  VAELoader:              { role: 'vae',        multi: 'VAELoaderMultiGPU' },
  CLIPVisionLoader:       { role: 'clipVision', multi: 'CLIPVisionLoaderMultiGPU' },
  ControlNetLoader:       { role: 'controlNet', multi: 'ControlNetLoaderMultiGPU' },
};

const DEVICE_ROLES = ['unet', 'clip', 'vae', 'audioVae', 'clipVision', 'controlNet'];

// The node the pack must provide for placement to work at all.
const PROBE_NODE = 'UNETLoaderMultiGPU';

function roleFor(node, modelConfig) {
  const spec = LOADERS[node.class_type];
  if (!spec) return null;
  // A second VAELoader carrying the model's audio VAE file is the audio VAE.
  if (spec.role === 'vae' && modelConfig.audioVaeName && node.inputs?.vae_name === modelConfig.audioVaeName) {
    return { role: 'audioVae', multi: spec.multi };
  }
  return spec;
}

// Drops 'auto' / unknown roles so configs only store real placements.
function normalizeDevices(devices) {
  if (!devices || typeof devices !== 'object') return null;
  const out = {};
  for (const role of DEVICE_ROLES) {
    const v = devices[role];
    if (typeof v === 'string' && v && v !== 'auto') out[role] = v;
  }
  return Object.keys(out).length ? out : null;
}

function applyDevicePlacement(workflow, modelConfig = {}) {
  const devices = normalizeDevices(modelConfig.devices);
  if (!devices) return workflow;
  for (const node of Object.values(workflow)) {
    const spec = roleFor(node, modelConfig);
    if (!spec) continue;
    const device = devices[spec.role];
    if (!device) continue;
    node.class_type = spec.multi;
    node.inputs = { ...node.inputs, device };
  }
  return workflow;
}

function usesMultiGpuNodes(workflow) {
  return Object.values(workflow ?? {}).some(n => /MultiGPU$/.test(n?.class_type ?? ''));
}

module.exports = { applyDevicePlacement, normalizeDevices, usesMultiGpuNodes, DEVICE_ROLES, LOADERS, PROBE_NODE };

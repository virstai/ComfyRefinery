'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { inspect, archBaseNodes, PACKS, compareVersions } = require('../../src/services/nodeRequirements');
const { architectures } = require('../../src/workflows');

// A node index that has every core node every arch emits, but no custom packs.
function coreIndex() {
  const idx = {};
  for (const arch of architectures) for (const n of archBaseNodes(arch) ?? []) idx[n] = 'nodes';
  // the wrapper packs' nodes are emitted by their archs — drop them again
  for (const p of PACKS) for (const n of p.nodes ?? []) delete idx[n];
  return idx;
}

test('every architecture builds a base graph from the dummy config', () => {
  for (const arch of architectures) {
    const nodes = archBaseNodes(arch);
    assert.ok(Array.isArray(nodes) && nodes.length > 3, `${arch} builds (${nodes?.length} nodes)`);
  }
});

test('archs are available when every emitted node exists; wrapper-based archs need their pack', () => {
  const out = inspect({ nodeIndex: coreIndex(), samplers: ['euler'], coreVersion: '0.34.0' });
  const by = Object.fromEntries(out.archs.map(a => [a.arch, a]));
  assert.equal(by.sdxl.available, true);
  assert.equal(by.minimaxh3.available, true);
  assert.equal(by.cogvideox.available, false, 'needs the CogVideoX wrapper');
  assert.deepEqual(by.cogvideox.requiredPacks.map(p => p.id), ['cogvideox_wrapper']);
  assert.equal(by.cogvideox.requiredPacks[0].installed, false);
  assert.ok(by.cogvideox.missingNodes.includes('CogVideoXModelLoader'));
  assert.equal(by.hunyuanvideo.available, false);
});

test('installed packs are detected from their nodes and attributed to a module', () => {
  const idx = { ...coreIndex(), UNETLoaderMultiGPU: 'custom_nodes.ComfyUI-MultiGPU', CLIPLoaderMultiGPU: 'custom_nodes.ComfyUI-MultiGPU',
    DualCLIPLoaderMultiGPU: 'custom_nodes.ComfyUI-MultiGPU', VAELoaderMultiGPU: 'custom_nodes.ComfyUI-MultiGPU', CheckpointLoaderSimpleMultiGPU: 'custom_nodes.ComfyUI-MultiGPU',
    CLIPVisionLoaderMultiGPU: 'custom_nodes.ComfyUI-MultiGPU', ControlNetLoaderMultiGPU: 'custom_nodes.ComfyUI-MultiGPU',
    DWPreprocessor: 'custom_nodes.comfyui_controlnet_aux', SomethingElse: 'custom_nodes.rgthree-comfy' };
  const out = inspect({ nodeIndex: idx, samplers: [], coreVersion: '0.34.0' });
  const pack = id => out.packs.find(p => p.id === id);
  assert.equal(pack('multigpu').installed, true);
  assert.deepEqual(pack('multigpu').modules, ['custom_nodes.ComfyUI-MultiGPU']);
  assert.equal(pack('controlnet_aux').installed, false, 'only one of its nodes present');
  assert.ok(pack('controlnet_aux').missingNodes.includes('HEDPreprocessor'));
  assert.equal(pack('res4lyf').installed, false);
  assert.deepEqual(pack('res4lyf').missingSamplers, ['er_sde']);
  const other = out.installedPacks.find(p => p.name === 'rgthree-comfy');
  assert.ok(other && other.known === null && other.nodeCount === 1);
  assert.equal(out.installedPacks.find(p => p.name === 'ComfyUI-MultiGPU').known, 'multigpu');
});

test('sampler-provided packs count as installed when the sampler exists', () => {
  const out = inspect({ nodeIndex: coreIndex(), samplers: ['euler', 'er_sde'] });
  assert.equal(out.packs.find(p => p.id === 'res4lyf').installed, true);
});

test('core version gate marks an arch unavailable on old ComfyUI', () => {
  const out = inspect({ nodeIndex: coreIndex(), samplers: [], coreVersion: '0.29.1' });
  const h3 = out.archs.find(a => a.arch === 'minimaxh3');
  assert.equal(h3.coreOk, false);
  assert.equal(h3.available, false);
  assert.equal(compareVersions('0.34.0', '0.30.0') > 0, true);
  assert.equal(compareVersions('0.30', '0.30.0'), 0);
});

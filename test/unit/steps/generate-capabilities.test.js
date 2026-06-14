'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const generate = require('../../../src/steps/generate');

const types = wf => Object.values(wf).map(n => n.class_type);

test('adapter refMode on anima (capability disabled) falls through to txt2img', () => {
  const modelConfig = {
    architecture: 'anima', unetName: 'anima.safetensors', clipL: 'qwen.safetensors',
    vaeName: 'vae.safetensors', adapterModel: 'anima_ipa.safetensors',
  };
  const wf = generate.buildComfyWorkflow(
    { referenceStrategy: { diffusion: { mode: 'adapter' } } },
    { params: { ...modelConfig, positivePrompt: 'a knight' } },
    { modelConfig, references: [{ filename: 'ref.png', subfolder: '' }] },
  );
  assert.ok(!types(wf).includes('AnimaIPAdapterLoader'), 'no adapter loader');
  assert.ok(!types(wf).includes('AnimaIPAdapterApply'),  'no adapter apply');
  assert.ok(!types(wf).includes('VAEEncode'), 'txt2img — refs not used as init image either');
});

test('adapter refMode on sd15 (capability enabled) builds the IPAdapter chain', () => {
  const modelConfig = {
    architecture: 'sd15', checkpoint: 'sd15.safetensors',
    adapterModel: 'ip-adapter_sd15.safetensors',
  };
  const wf = generate.buildComfyWorkflow(
    { referenceStrategy: { diffusion: { mode: 'adapter' } } },
    { params: { ...modelConfig, positivePrompt: 'a knight' } },
    { modelConfig, references: [{ filename: 'ref.png', subfolder: '' }] },
  );
  assert.ok(types(wf).includes('IPAdapter'), 'IPAdapter chain present');
});

test('prePass throws on a poseMode step whose arch has no controlNet capability', async () => {
  await assert.rejects(
    generate.prePass(
      { controlNet: { poseMode: 'always', strength: 1.0 } },
      { params: {}, wantsPose: true, poseDescription: 'standing' },
      { modelConfig: { architecture: 'chroma', label: 'Chroma' }, cfg: {} },
    ),
    /not supported on the "chroma" architecture/,
  );
});

test('prePass still returns null when poseMode is off, regardless of arch', async () => {
  const out = await generate.prePass(
    { controlNet: { poseMode: 'off' } },
    { params: {} },
    { modelConfig: { architecture: 'chroma' }, cfg: {} },
  );
  assert.equal(out, null);
});

test('tile chainStrategy: sets initImage + denoise so SDXL starts from chained content, not noise', () => {
  const chainedRef = { filename: 'prev.png', subfolder: '' };
  const modelConfig = {
    architecture: 'sdxl', checkpoint: 'sdxl.safetensors', vae: 'vae.safetensors',
    tileControlNetModel: 'cn-tile.safetensors',
  };
  const wf = generate.buildComfyWorkflow(
    { chainStrategy: { mode: 'tile', tileStrength: 0.6 }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'a knight', width: 1024, height: 1024 } },
    { modelConfig, chainedInputRef: chainedRef },
  );
  const nodeTypes = Object.values(wf).map(n => n.class_type);
  // Must have an init image (VAEEncode) — no longer txt2img from noise
  assert.ok(nodeTypes.includes('VAEEncode'), 'VAEEncode present: img2img init');
  // Tile CN nodes must also be present
  assert.ok(nodeTypes.includes('ControlNetApplyAdvanced'), 'tile CN applied');
});

test('tile mode from refs (controlNet.tile) also uses init-image, not empty latent', () => {
  const refImage = { filename: 'ref.png', subfolder: '' };
  const modelConfig = {
    architecture: 'sdxl', checkpoint: 'sdxl.safetensors',
    tileControlNetModel: 'cn-tile.safetensors',
  };
  const wf = generate.buildComfyWorkflow(
    { controlNet: { tile: { enabled: true, strength: 0.6 } }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'a knight', width: 1024, height: 1024 } },
    { modelConfig, references: [refImage] },
  );
  const nodeTypes = Object.values(wf).map(n => n.class_type);
  assert.ok(nodeTypes.includes('VAEEncode'), 'VAEEncode: ref tile also sets init image');
  assert.ok(nodeTypes.includes('ControlNetApplyAdvanced'), 'tile CN applied from ref');
});

test('tile chainStrategy: without tileControlNetModel on the model, falls through to txt2img', () => {
  const chainedRef = { filename: 'prev.png', subfolder: '' };
  const modelConfig = {
    architecture: 'sdxl', checkpoint: 'sdxl.safetensors',
    // no tileControlNetModel
  };
  const wf = generate.buildComfyWorkflow(
    { chainStrategy: { mode: 'tile', tileStrength: 0.6 }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'a knight', width: 1024, height: 1024 } },
    { modelConfig, chainedInputRef: chainedRef },
  );
  const nodeTypes = Object.values(wf).map(n => n.class_type);
  assert.ok(!nodeTypes.includes('ControlNetApplyAdvanced'), 'no tile CN when model missing');
});

test('structural chainStrategy: applies preprocessor inline, no init image (pure txt2img)', () => {
  const chainedRef = { filename: 'klein.png', subfolder: '' };
  const modelConfig = {
    architecture: 'sdxl', checkpoint: 'sdxl.safetensors',
    structuralControlNetModel: 'illustrious-depth.safetensors',
  };
  const wf = generate.buildComfyWorkflow(
    { chainStrategy: { mode: 'structural', preprocessor: 'depth', strength: 0.9 }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'anime character', width: 1024, height: 1024 } },
    { modelConfig, chainedInputRef: chainedRef },
  );
  const nodeTypes = Object.values(wf).map(n => n.class_type);
  // Must have structural CN nodes
  assert.ok(nodeTypes.includes('MiDaS-DepthMapPreprocessor'), 'depth preprocessor node');
  assert.ok(nodeTypes.includes('ControlNetApplyAdvanced'),    'CN apply node');
  // Must NOT have init image: SDXL generates from noise for full style freedom
  assert.ok(!nodeTypes.includes('VAEEncode'), 'no VAEEncode: pure txt2img, no init image');
});

test('structural chainStrategy: softedge uses HEDPreprocessor', () => {
  const chainedRef = { filename: 'klein.png', subfolder: '' };
  const modelConfig = {
    architecture: 'sdxl', checkpoint: 'sdxl.safetensors',
    structuralControlNetModel: 'illustrious-softedge.safetensors',
  };
  const wf = generate.buildComfyWorkflow(
    { chainStrategy: { mode: 'structural', preprocessor: 'softedge', strength: 0.85 }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'anime character', width: 1024, height: 1024 } },
    { modelConfig, chainedInputRef: chainedRef },
  );
  const nodeTypes = Object.values(wf).map(n => n.class_type);
  assert.ok(nodeTypes.includes('HEDPreprocessor'), 'softedge uses HEDPreprocessor');
});

test('structural chainStrategy: falls through when structuralControlNetModel missing', () => {
  const chainedRef = { filename: 'klein.png', subfolder: '' };
  const modelConfig = { architecture: 'sdxl', checkpoint: 'sdxl.safetensors' };
  const wf = generate.buildComfyWorkflow(
    { chainStrategy: { mode: 'structural', preprocessor: 'depth' }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'anime', width: 1024, height: 1024 } },
    { modelConfig, chainedInputRef: chainedRef },
  );
  const nodeTypes = Object.values(wf).map(n => n.class_type);
  assert.ok(!nodeTypes.includes('ControlNetApplyAdvanced'), 'no CN when model missing');
});

test('structural chainStrategy: end_percent defaults to 0.65 to free detail-pass steps', () => {
  const chainedRef = { filename: 'klein.png', subfolder: '' };
  const modelConfig = { architecture: 'sdxl', checkpoint: 'sdxl.safetensors', structuralControlNetModel: 'depth.safetensors' };
  const wf = generate.buildComfyWorkflow(
    { chainStrategy: { mode: 'structural', strength: 0.9 }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'anime', width: 1024, height: 1024 } },
    { modelConfig, chainedInputRef: chainedRef },
  );
  const cnNode = Object.values(wf).find(n => n.class_type === 'ControlNetApplyAdvanced');
  assert.ok(cnNode, 'CN apply node present');
  assert.equal(cnNode.inputs.end_percent, 0.65, 'default end_percent is 0.65');
});

test('structural chainStrategy: custom endPercent is forwarded to end_percent', () => {
  const chainedRef = { filename: 'klein.png', subfolder: '' };
  const modelConfig = { architecture: 'sdxl', checkpoint: 'sdxl.safetensors', structuralControlNetModel: 'depth.safetensors' };
  const wf = generate.buildComfyWorkflow(
    { chainStrategy: { mode: 'structural', strength: 0.9, endPercent: 0.5 }, referenceStrategy: { diffusion: { mode: 'txt2img' } } },
    { params: { ...modelConfig, positivePrompt: 'anime', width: 1024, height: 1024 } },
    { modelConfig, chainedInputRef: chainedRef },
  );
  const cnNode = Object.values(wf).find(n => n.class_type === 'ControlNetApplyAdvanced');
  assert.equal(cnNode.inputs.end_percent, 0.5, 'custom endPercent forwarded');
});

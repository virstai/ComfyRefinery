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

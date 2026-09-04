'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { build, defaults, RECIPES } = require('../../../src/workflows/ltxvideo');

const BASE = {
  checkpoint:     'ltx-2.3-22b-dev-fp8.safetensors',
  clipName:       'gemma_3_12B_it_fp4_mixed.safetensors',
  positivePrompt: 'a flowing river',
};
const LORA     = 'ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors';
const UPSCALER = 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors';
const IMG      = { inputRef: { filename: 'img.png', subfolder: '' }, isI2V: true };

const nodesOf   = (wf, type) => Object.values(wf).filter(n => n.class_type === type);
const nodeOf    = (wf, type) => nodesOf(wf, type)[0];
const nodeTypes = wf => Object.values(wf).map(n => n.class_type);
const byRef     = (wf, ref) => wf[ref[0]];

test('ltxvideo T2V (full, single stage): official node set with SamplerCustomAdvanced + CFGGuider, tiled decode', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  for (const t of ['CheckpointLoaderSimple', 'LTXAVTextEncoderLoader', 'CLIPTextEncode', 'LTXVConditioning', 'EmptyLTXVLatentVideo',
                   'LTXVScheduler', 'RandomNoise', 'KSamplerSelect', 'CFGGuider', 'SamplerCustomAdvanced', 'VAEDecodeTiled', 'CreateVideo', 'SaveVideo']) {
    assert.ok(types.includes(t), t);
  }
  for (const t of ['KSampler', 'ModelSamplingLTXV', 'LTX2LoraLoaderAdvanced', 'LTXVAddGuide', 'LoadImage', 'LTXVLatentUpsampler', 'ManualSigmas', 'VAEDecode']) {
    assert.ok(!types.includes(t), `no ${t}`);
  }
  assert.equal(nodesOf(wf, 'SamplerCustomAdvanced').length, 1, 'single stage without an upscaler');
  // full recipe: cfg = guidance, 30 steps, euler_ancestral, base model straight into the guider
  const guider = nodeOf(wf, 'CFGGuider');
  assert.equal(guider.inputs.cfg, defaults.guidance);
  assert.equal(byRef(wf, guider.inputs.model).class_type, 'CheckpointLoaderSimple');
  const sched = nodeOf(wf, 'LTXVScheduler');
  assert.equal(sched.inputs.steps, RECIPES.full.steps);
  assert.equal(sched.inputs.max_shift, 2.72);
  assert.equal(sched.inputs.base_shift, 0.8);
  assert.equal(sched.inputs.terminal, 0);
  assert.equal(sched.inputs.stretch, true);
  assert.deepEqual(sched.inputs.latent, nodeOf(wf, 'SamplerCustomAdvanced').inputs.latent_image, 'scheduler sees the sampled latent');
  assert.equal(nodeOf(wf, 'KSamplerSelect').inputs.sampler_name, 'euler_ancestral');
  const decode = nodeOf(wf, 'VAEDecodeTiled');
  assert.deepEqual([decode.inputs.tile_size, decode.inputs.overlap, decode.inputs.temporal_size, decode.inputs.temporal_overlap], [768, 64, 4096, 4]);
});

test('ltxvideo: negative prompt defaults to the official one and is overridable', () => {
  const encodes = nodesOf(build(BASE), 'CLIPTextEncode').map(n => n.inputs.text);
  assert.ok(encodes.includes(defaults.negativePrompt));
  assert.match(defaults.negativePrompt, /cartoon/);
  const custom = nodesOf(build({ ...BASE, negativePrompt: 'blurry' }), 'CLIPTextEncode').map(n => n.inputs.text);
  assert.ok(custom.includes('blurry'));
  assert.ok(!custom.includes(defaults.negativePrompt));
});

test('ltxvideo: distilled recipe when a distilled LoRA is set — LoRA at 0.7 under the guider, cfg 1, 8 steps, cfg_pp sampler', () => {
  const wf = build({ ...BASE, distilledLoraName: LORA });
  const guider = nodeOf(wf, 'CFGGuider');
  assert.equal(guider.inputs.cfg, 1);
  const lora = byRef(wf, guider.inputs.model);
  assert.equal(lora.class_type, 'LoraLoaderModelOnly');
  assert.equal(lora.inputs.lora_name, LORA);
  assert.equal(lora.inputs.strength_model, 0.7);
  const sched = nodeOf(wf, 'LTXVScheduler');
  assert.equal(sched.inputs.steps, 8);
  assert.equal(sched.inputs.max_shift, 4);
  assert.equal(sched.inputs.base_shift, 1.5);
  assert.equal(sched.inputs.terminal, 0.1);
  assert.equal(nodeOf(wf, 'KSamplerSelect').inputs.sampler_name, 'euler_ancestral_cfg_pp');
  // explicit step count / sampler / guidance: steps and sampler win, guidance is ignored (distilled is cfg 1)
  const wf2 = build({ ...BASE, distilledLoraName: LORA, steps: 12, sampler: 'euler', guidance: 5 });
  assert.equal(nodeOf(wf2, 'LTXVScheduler').inputs.steps, 12);
  assert.equal(nodeOf(wf2, 'KSamplerSelect').inputs.sampler_name, 'euler');
  assert.equal(nodeOf(wf2, 'CFGGuider').inputs.cfg, 1);
});

test('ltxvideo: samplingMode "full" with a LoRA keeps the LoRA out of stage 1 (Sulphur base recipe)', () => {
  const wf = build({ ...BASE, distilledLoraName: LORA, samplingMode: 'full', guidance: 4 });
  const guider = nodeOf(wf, 'CFGGuider');
  assert.equal(guider.inputs.cfg, 4);
  assert.equal(byRef(wf, guider.inputs.model).class_type, 'CheckpointLoaderSimple');
  assert.ok(!nodeTypes(wf).includes('LoraLoaderModelOnly'), 'no LoRA without a refine stage');
});

test('ltxvideo: distilled mode without a LoRA, or an upscaler without a LoRA, is a config error', () => {
  assert.throws(() => build({ ...BASE, samplingMode: 'distilled' }), /distilled LoRA/);
  assert.throws(() => build({ ...BASE, upscaleModel: UPSCALER }), /distilled LoRA/);
  assert.throws(() => build({ ...BASE, samplingMode: 'weird' }), /samplingMode/);
});

test('ltxvideo two-stage: half-size stage 1 → LTXVLatentUpsampler ×2 → LCM refine with the LoRA at 0.5 and cfg 1', () => {
  const wf = build({ ...BASE, distilledLoraName: LORA, upscaleModel: UPSCALER, width: 1024, height: 576 });
  const latent = nodeOf(wf, 'EmptyLTXVLatentVideo');
  assert.equal(latent.inputs.width,  512);
  assert.equal(latent.inputs.height, 288);
  const runs = nodesOf(wf, 'SamplerCustomAdvanced');
  assert.equal(runs.length, 2);
  const [s1, s2] = runs;
  // stage 2 samples the upscaled latent
  const up = nodeOf(wf, 'LTXVLatentUpsampler');
  assert.equal(byRef(wf, up.inputs.upscale_model).class_type, 'LatentUpscaleModelLoader');
  assert.equal(nodeOf(wf, 'LatentUpscaleModelLoader').inputs.model_name, UPSCALER);
  assert.equal(byRef(wf, up.inputs.samples), s1, 'upsampler reads the stage-1 output (no audio → no separation)');
  assert.equal(byRef(wf, s2.inputs.latent_image), up, 'refine samples the upscaled latent');
  const s2Guider = byRef(wf, s2.inputs.guider);
  assert.equal(s2Guider.inputs.cfg, 1);
  const s2Lora = byRef(wf, s2Guider.inputs.model);
  assert.equal(s2Lora.class_type, 'LoraLoaderModelOnly');
  assert.equal(s2Lora.inputs.strength_model, 0.5);
  assert.equal(byRef(wf, s2.inputs.sampler).inputs.sampler_name, 'lcm');
  const sigmas = byRef(wf, s2.inputs.sigmas);
  assert.equal(sigmas.class_type, 'ManualSigmas');
  assert.equal(sigmas.inputs.sigmas, RECIPES.distilled.refineSigmas);
  // stage 1 still uses the scheduler
  assert.equal(byRef(wf, s1.inputs.sigmas).class_type, 'LTXVScheduler');
  // the decoder reads the refined latent
  assert.deepEqual(nodeOf(wf, 'VAEDecodeTiled').inputs.samples, [Object.keys(wf).find(k => wf[k] === s2), 0]);
  // full recipe → 5-step refine sigmas
  const wfFull = build({ ...BASE, distilledLoraName: LORA, upscaleModel: UPSCALER, samplingMode: 'full' });
  assert.equal(nodeOf(wfFull, 'ManualSigmas').inputs.sigmas, RECIPES.full.refineSigmas);
});

test('ltxvideo two-stage: output size is twice the /32 half-size grid', () => {
  const wf = build({ ...BASE, distilledLoraName: LORA, upscaleModel: UPSCALER, width: 1280, height: 720 });
  const latent = nodeOf(wf, 'EmptyLTXVLatentVideo');
  assert.equal(latent.inputs.width,  640);
  assert.equal(latent.inputs.height, 352, '720/2 = 360 floors to the /32 grid');
});

test('ltxvideo I2V: LoadImage → ImageScale (centre crop to the output size) → LTXVPreprocess → LTXVImgToVideoInplace, no LTXVAddGuide', () => {
  const wf = build({ ...BASE, ...IMG, width: 1024, height: 576 });
  const types = nodeTypes(wf);
  assert.ok(types.includes('LoadImage'));
  assert.ok(!types.includes('LTXVAddGuide'));
  const scale = nodeOf(wf, 'ImageScale');
  assert.deepEqual([scale.inputs.width, scale.inputs.height, scale.inputs.crop, scale.inputs.upscale_method], [1024, 576, 'center', 'lanczos']);
  const prep = nodeOf(wf, 'LTXVPreprocess');
  assert.equal(prep.inputs.img_compression, 18);
  assert.equal(byRef(wf, prep.inputs.image).class_type, 'ImageScale');
  const inplace = nodesOf(wf, 'LTXVImgToVideoInplace');
  assert.equal(inplace.length, 1);
  assert.equal(inplace[0].inputs.strength, 1.0, 'single stage anchors the first frame fully');
  assert.equal(byRef(wf, inplace[0].inputs.image).class_type, 'LTXVPreprocess');
  assert.equal(byRef(wf, inplace[0].inputs.latent).class_type, 'EmptyLTXVLatentVideo');
});

test('ltxvideo I2V two-stage: first frame written at 0.7 into stage 1 and at 1.0 after the upscale', () => {
  const wf = build({ ...BASE, ...IMG, distilledLoraName: LORA, upscaleModel: UPSCALER });
  const inplace = nodesOf(wf, 'LTXVImgToVideoInplace');
  assert.equal(inplace.length, 2);
  const s1 = inplace.find(n => byRef(wf, n.inputs.latent).class_type === 'EmptyLTXVLatentVideo');
  const s2 = inplace.find(n => byRef(wf, n.inputs.latent).class_type === 'LTXVLatentUpsampler');
  assert.equal(s1.inputs.strength, 0.7);
  assert.equal(s2.inputs.strength, 1.0);
  assert.deepEqual(s1.inputs.image, s2.inputs.image, 'same preprocessed image feeds both');
});

test('ltxvideo: default dimensions and frame snapping (8n+1)', () => {
  const latent = nodeOf(build(BASE), 'EmptyLTXVLatentVideo');
  assert.equal(latent.inputs.width,  defaults.width);
  assert.equal(latent.inputs.height, defaults.height);
  assert.equal(latent.inputs.length, 121);
  assert.equal(nodeOf(build({ ...BASE, frames: 118 }), 'EmptyLTXVLatentVideo').inputs.length, 121);
  assert.equal(nodeOf(build({ ...BASE, frames: 113 }), 'EmptyLTXVLatentVideo').inputs.length, 113);
  assert.equal(nodeOf(build({ ...BASE, frames: 97 }),  'EmptyLTXVLatentVideo').inputs.length, 97);
});

test('ltxvideo: CreateVideo uses fps; conditioning carries the frame rate', () => {
  const wf = build({ ...BASE, fps: 30 });
  assert.equal(nodeOf(wf, 'CreateVideo').inputs.fps, 30);
  assert.equal(nodeOf(wf, 'LTXVConditioning').inputs.frame_rate, 30);
});

test('ltxvideo: seed feeds every RandomNoise', () => {
  const wf = build({ ...BASE, distilledLoraName: LORA, upscaleModel: UPSCALER, seed: 4242 });
  const noises = nodesOf(wf, 'RandomNoise');
  assert.equal(noises.length, 2);
  for (const n of noises) assert.equal(n.inputs.noise_seed, 4242);
});

test('ltxvideo: no audio nodes without enableAudio; CreateVideo has no audio input', () => {
  const wf = build(BASE);
  const types = nodeTypes(wf);
  for (const t of ['LTXVAudioVAELoader', 'LTXVEmptyLatentAudio', 'LTXVConcatAVLatent', 'LTXVSeparateAVLatent', 'LTXVAudioVAEDecode', 'SaveAudio']) {
    assert.ok(!types.includes(t), `no ${t}`);
  }
  assert.ok(!nodeOf(wf, 'CreateVideo').inputs.audio);
});

test('ltxvideo with audio: AV latents concatenated for sampling, separated for decode, audio muxed into CreateVideo', () => {
  const wf = build({ ...BASE, enableAudio: true });
  const types = nodeTypes(wf);
  for (const t of ['LTXVAudioVAELoader', 'LTXVEmptyLatentAudio', 'LTXVConcatAVLatent', 'LTXVSeparateAVLatent', 'LTXVAudioVAEDecode']) {
    assert.ok(types.includes(t), t);
  }
  assert.ok(!types.includes('SaveAudio'), 'no separate SaveAudio — audio goes into CreateVideo');
  assert.equal(nodeOf(wf, 'LTXVAudioVAELoader').inputs.ckpt_name, BASE.checkpoint);
  assert.equal(nodeOf(wf, 'LTXVEmptyLatentAudio').inputs.frames_number, 121);
  assert.equal(byRef(wf, nodeOf(wf, 'SamplerCustomAdvanced').inputs.latent_image).class_type, 'LTXVConcatAVLatent');
  assert.equal(byRef(wf, nodeOf(wf, 'VAEDecodeTiled').inputs.samples).class_type, 'LTXVSeparateAVLatent');
  assert.ok(nodeOf(wf, 'CreateVideo').inputs.audio, 'CreateVideo has audio input');
});

test('ltxvideo with audio, two-stage: the stage-1 audio latent is carried into the refine untouched', () => {
  const wf = build({ ...BASE, enableAudio: true, distilledLoraName: LORA, upscaleModel: UPSCALER });
  const concats = nodesOf(wf, 'LTXVConcatAVLatent');
  assert.equal(concats.length, 2);
  const refineConcat = concats.find(c => byRef(wf, c.inputs.video_latent).class_type === 'LTXVLatentUpsampler');
  assert.ok(refineConcat, 'refine concat takes the upscaled video latent');
  const sep = byRef(wf, refineConcat.inputs.audio_latent);
  assert.equal(sep.class_type, 'LTXVSeparateAVLatent');
  assert.equal(refineConcat.inputs.audio_latent[1], 1, 'audio slot of the stage-1 separation');
  assert.equal(nodesOf(wf, 'LTXVSeparateAVLatent').length, 2);
});

test('ltxvideo: step/segment LoRAs chain model-only under the distilled LoRA on both stages', () => {
  const loras = [{ name: 'sulphur_lora_rank_768.safetensors', weight: 0.8 }];
  const wf = build({ ...BASE, distilledLoraName: LORA, upscaleModel: UPSCALER, loras });
  const loraNodes = nodesOf(wf, 'LoraLoaderModelOnly');
  const extra = loraNodes.filter(n => n.inputs.lora_name === loras[0].name);
  assert.equal(extra.length, 1, 'the extra LoRA is loaded once and shared');
  assert.equal(extra[0].inputs.strength_model, 0.8);
  assert.equal(byRef(wf, extra[0].inputs.model).class_type, 'CheckpointLoaderSimple');
  const distilled = loraNodes.filter(n => n.inputs.lora_name === LORA);
  assert.equal(distilled.length, 2, 'one distilled LoRA node per stage');
  for (const d of distilled) assert.equal(byRef(wf, d.inputs.model), extra[0], 'distilled LoRA sits on top of the extra LoRA');
  assert.ok(!nodeTypes(wf).includes('LoraLoader'), 'never the CLIP-touching loader');
});

test('ltxvideo: external video / audio VAE files load through VAELoader (placeable per device) instead of the checkpoint', () => {
  const wf = build({ ...BASE, ...IMG, enableAudio: true, distilledLoraName: LORA, upscaleModel: UPSCALER,
                     vae: 'ltx-2.3-video-vae.safetensors', audioVaeName: 'ltx-2.3-audio-vae.safetensors' });
  const loaders = nodesOf(wf, 'VAELoader');
  assert.equal(loaders.length, 2);
  const video = loaders.find(n => n.inputs.vae_name === 'ltx-2.3-video-vae.safetensors');
  const audio = loaders.find(n => n.inputs.vae_name === 'ltx-2.3-audio-vae.safetensors');
  assert.ok(video && audio);
  assert.ok(!nodeTypes(wf).includes('LTXVAudioVAELoader'), 'no in-checkpoint audio VAE loader');
  const videoRef = [Object.keys(wf).find(k => wf[k] === video), 0];
  const audioRef = [Object.keys(wf).find(k => wf[k] === audio), 0];
  // every VAE consumer reads the external video VAE; audio nodes the external audio VAE
  for (const t of ['VAEDecodeTiled', 'LTXVLatentUpsampler']) assert.deepEqual(nodeOf(wf, t).inputs.vae, videoRef, t);
  for (const n of nodesOf(wf, 'LTXVImgToVideoInplace')) assert.deepEqual(n.inputs.vae, videoRef);
  assert.deepEqual(nodeOf(wf, 'LTXVEmptyLatentAudio').inputs.audio_vae, audioRef);
  assert.deepEqual(nodeOf(wf, 'LTXVAudioVAEDecode').inputs.audio_vae, audioRef);
  // default: both come from the checkpoint
  const wf2 = build({ ...BASE, enableAudio: true });
  assert.ok(!nodeTypes(wf2).includes('VAELoader'));
  assert.deepEqual(nodeOf(wf2, 'VAEDecodeTiled').inputs.vae, [Object.keys(wf2).find(k => wf2[k].class_type === 'CheckpointLoaderSimple'), 2]);
  assert.equal(nodeOf(wf2, 'LTXVAudioVAELoader').inputs.ckpt_name, BASE.checkpoint);
});

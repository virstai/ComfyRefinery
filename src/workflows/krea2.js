'use strict';

const { applyModelOnlyLoraChain } = require('./lib/loraChain');

const defaults = {
  width:          1024,
  height:         1024,
  steps:          8,
  cfgScale:       1.0,
  sampler:        'euler',
  scheduler:      'simple',
  negativePrompt: '',
};

function build(params) {
  const p    = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: p.unetName, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: p.clipName, type: "krea2" } },
    "3": { class_type: "VAELoader",  inputs: { vae_name: p.vaeName } },
  };

  // LoRAs are trained on the DiT only — LoraLoaderModelOnly, CLIP path untouched.
  let modelRef = ["1", 0];
  const clipRef = ["2", 0];
  modelRef = applyModelOnlyLoraChain(nodes, modelRef, p.loras);

  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: p.positivePrompt, clip: clipRef } };
  // At CFG 1.0 (Turbo default) the uncond branch is never sampled, so ComfyUI's own
  // template feeds ConditioningZeroOut as negative. Above CFG 1 (Raw territory) a real
  // negative prompt is needed for it to have any effect.
  if (p.cfgScale > 1) {
    nodes["6"] = { class_type: "CLIPTextEncode", inputs: { text: p.negativePrompt ?? '', clip: clipRef } };
  } else {
    nodes["6"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } };
  }

  let latentRef;
  let denoise;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    nodes["16"] = { class_type: "LoadImage", inputs: { image: imgPath } };
    nodes["17"] = { class_type: "VAEEncode",  inputs: { pixels: ["16", 0], vae: ["3", 0] } };
    latentRef = ["17", 0];
    denoise   = p.denoise ?? 0.6;
  } else {
    nodes["7"] = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latentRef = ["7", 0];
    denoise   = 1.0;
  }

  // No ModelSampling* node — Krea 2's shift (1.15) is baked into ComfyUI's model detection,
  // so KSampler reads the post-LoRA model directly.
  nodes["8"]  = { class_type: "KSampler", inputs: {
    seed, steps: p.steps, cfg: p.cfgScale,
    sampler_name: p.sampler, scheduler: p.scheduler, denoise,
    model: modelRef, positive: ["5", 0], negative: ["6", 0], latent_image: latentRef,
  }};
  nodes["9"]  = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } };
  nodes["10"] = { class_type: "SaveImage",  inputs: { filename_prefix: "iterator", images: ["9", 0] } };

  return nodes;
}

module.exports = { build, defaults };

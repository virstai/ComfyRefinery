'use strict';

const { applyLoraChain } = require('./lib/loraChain');

const defaults = {
  width:          1024,
  height:         1024,
  steps:          25,
  cfgScale:       4.0,
  sampler:        'res_multistep',
  scheduler:      'simple',
  negativePrompt: '',
};

function build(params) {
  const p    = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: p.unetName, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: p.clipName, type: "lumina2" } },
    "3": { class_type: "VAELoader",  inputs: { vae_name: p.vaeName } },
  };

  let modelRef = ["1", 0];
  let clipRef  = ["2", 0];
  ({ modelRef, clipRef } = applyLoraChain(nodes, modelRef, clipRef, p.loras));

  nodes["4"] = { class_type: "ModelSamplingAuraFlow", inputs: { model: modelRef, shift: 3 } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: p.positivePrompt,      clip: clipRef } };
  nodes["6"] = { class_type: "CLIPTextEncode", inputs: { text: p.negativePrompt ?? '', clip: clipRef } };

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
    nodes["7"] = { class_type: "EmptySD3LatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latentRef = ["7", 0];
    denoise   = 1.0;
  }

  nodes["8"]  = { class_type: "KSampler", inputs: {
    seed, steps: p.steps, cfg: p.cfgScale,
    sampler_name: p.sampler, scheduler: p.scheduler, denoise,
    model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: latentRef,
  }};
  nodes["9"]  = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } };
  nodes["10"] = { class_type: "SaveImage",  inputs: { filename_prefix: "iterator", images: ["9", 0] } };

  return nodes;
}

module.exports = { build, defaults };

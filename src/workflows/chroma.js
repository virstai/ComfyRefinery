'use strict';

// ChromaHD workflow — all standard ComfyUI nodes, no custom node pack required.
// Split loading: unetName + clipName (T5 encoder) + vaeName.
const { applyLoraChain } = require('./lib/loraChain');

const defaults = {
  width:          1152,
  height:         1152,
  steps:          26,
  guidance:       3.8,
  sampler:        'euler',
  negativePrompt: '',
};

function build(params) {
  const p    = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {
    "1":  { class_type: "UNETLoader",  inputs: { unet_name: p.unetName, weight_dtype: "default" } },
    "2":  { class_type: "CLIPLoader",  inputs: { clip_name: p.clipName, type: "chroma", device: "default" } },
    "3":  { class_type: "VAELoader",   inputs: { vae_name: p.vaeName } },
  };

  let modelRef = ["1", 0];
  let clipRef  = ["2", 0];
  ({ modelRef, clipRef } = applyLoraChain(nodes, modelRef, clipRef, p.loras));

  nodes["4"]  = { class_type: "ModelSamplingAuraFlow", inputs: { model: modelRef, shift: 1.0 } };
  nodes["5"]  = { class_type: "T5TokenizerOptions",    inputs: { clip: clipRef, min_padding: 0, min_length: 0 } };
  nodes["6"]  = { class_type: "CLIPTextEncode",        inputs: { text: p.positivePrompt, clip: ["5", 0] } };
  nodes["7"]  = { class_type: "CLIPTextEncode",        inputs: { text: p.negativePrompt, clip: ["5", 0] } };
  nodes["8"]  = { class_type: "CFGGuider",             inputs: { model: ["4", 0], positive: ["6", 0], negative: ["7", 0], cfg: p.guidance } };
  nodes["10"] = { class_type: "RandomNoise",           inputs: { noise_seed: seed } };
  nodes["11"] = { class_type: "KSamplerSelect",        inputs: { sampler_name: p.sampler } };

  // img2img: swap EmptySD3LatentImage for LoadImage → VAEEncode;
  // replace BetaSamplingScheduler with BasicScheduler (which has a denoise param).
  let latentRef;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    nodes["16"] = { class_type: "LoadImage",      inputs: { image: imgPath } };
    nodes["17"] = { class_type: "VAEEncode",       inputs: { pixels: ["16", 0], vae: ["3", 0] } };
    nodes["12"] = { class_type: "BasicScheduler",  inputs: { model: ["4", 0], scheduler: "simple", steps: p.steps, denoise: p.denoise ?? 0.6 } };
    latentRef = ["17", 0];
  } else {
    nodes["9"]  = { class_type: "EmptySD3LatentImage",   inputs: { width: p.width, height: p.height, batch_size: 1 } };
    nodes["12"] = { class_type: "BetaSamplingScheduler", inputs: { model: ["4", 0], steps: p.steps, alpha: 0.45, beta: 0.45 } };
    latentRef = ["9", 0];
  }

  nodes["13"] = { class_type: "SamplerCustomAdvanced", inputs: { noise: ["10", 0], guider: ["8", 0], sampler: ["11", 0], sigmas: ["12", 0], latent_image: latentRef } };
  nodes["14"] = { class_type: "VAEDecode",             inputs: { samples: ["13", 0], vae: ["3", 0] } };
  nodes["15"] = { class_type: "SaveImage",             inputs: { filename_prefix: "iterator", images: ["14", 0] } };

  return nodes;
}

module.exports = { build, defaults };

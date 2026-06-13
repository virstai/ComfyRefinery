'use strict';

// SD3 / SD3.5 workflow — triple text encoders (CLIP-L, CLIP-G, T5), MMDiT architecture
const { applyLoraChain } = require('./lib/loraChain');

const defaults = {
  width: 1024,
  height: 1024,
  steps: 28,
  cfgScale: 4.5,
  sampler: 'euler',
  scheduler: 'sgm_uniform',
  negativePrompt: '',
};

function build(params) {
  const p = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
  };

  let modelRef = ["1", 0];
  let clipRef  = ["1", 1];
  ({ modelRef, clipRef } = applyLoraChain(nodes, modelRef, clipRef, p.loras));

  nodes["2"] = { class_type: "CLIPTextEncodeSD3", inputs: { text: p.positivePrompt, clip: clipRef } };
  nodes["3"] = { class_type: "CLIPTextEncodeSD3", inputs: { text: p.negativePrompt, clip: clipRef } };

  let latentRef;
  let denoise;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    nodes["8"] = { class_type: "LoadImage",  inputs: { image: imgPath } };
    nodes["9"] = { class_type: "VAEEncode",  inputs: { pixels: ["8", 0], vae: ["1", 2] } };
    latentRef = ["9", 0];
    denoise   = p.denoise ?? 0.6;
  } else {
    nodes["4"] = { class_type: "EmptySD3LatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latentRef = ["4", 0];
    denoise   = 1.0;
  }

  nodes["5"] = {
    class_type: "KSampler",
    inputs: {
      seed, steps: p.steps, cfg: p.cfgScale,
      sampler_name: p.sampler, scheduler: p.scheduler, denoise,
      model: modelRef, positive: ["2", 0], negative: ["3", 0], latent_image: latentRef,
    },
  };
  nodes["6"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } };
  nodes["7"] = { class_type: "SaveImage", inputs: { filename_prefix: "iterator", images: ["6", 0] } };
  return nodes;
}

module.exports = { build, defaults };

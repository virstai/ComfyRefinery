'use strict';

const { applyLoraChain } = require('./lib/loraChain');

const defaults = {
  width:          512,
  height:         512,
  steps:          20,
  cfgScale:       7,
  sampler:        'euler',
  scheduler:      'normal',
  negativePrompt: 'bad quality, blurry, watermark',
};

function build(params) {
  const p = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
  };

  // LoRA chain: threads model + clip through LoraLoader nodes 30, 31, ...
  let modelRef = ["1", 0];
  let clipRef  = ["1", 1];
  ({ modelRef, clipRef } = applyLoraChain(nodes, modelRef, clipRef, p.loras));

  nodes["2"] = { class_type: "CLIPTextEncode", inputs: { text: p.positivePrompt, clip: clipRef } };
  nodes["3"] = { class_type: "CLIPTextEncode", inputs: { text: p.negativePrompt, clip: clipRef } };

  if (p.vae) {
    nodes["8"] = { class_type: "VAELoader", inputs: { vae_name: p.vae } };
  }
  const vaeRef = p.vae ? ["8", 0] : ["1", 2];

  // IPAdapter chain:
  //   49 = IPAdapterModelLoader (load the specific file)
  //   50 = IPAdapterUnifiedLoader (patches model pipeline + auto-selects clip_vision via preset)
  //   51+i*2 = LoadImage, 52+i*2 = IPAdapter per ref image
  if (p.ipAdapterImages?.length && p.adapterModel) {
    const f = p.adapterModel.toLowerCase();
    const preset = f.includes('face') ? 'PLUS FACE (portraits)'
                 : f.includes('vit-g') || f.includes('vit_g') ? 'VIT-G (medium strength)'
                 : 'PLUS (high strength)';
    nodes["49"] = { class_type: "IPAdapterModelLoader",  inputs: { ipadapter_file: p.adapterModel } };
    nodes["50"] = { class_type: "IPAdapterUnifiedLoader", inputs: { model: modelRef, preset, ipadapter: ["49", 0] } };
    modelRef = ["50", 0];
    const perWeight = (p.adapterWeight ?? 0.6) / p.ipAdapterImages.length;
    p.ipAdapterImages.forEach((ref, i) => {
      const imgPath = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
      const loadId  = String(51 + i * 2);
      const ipaId   = String(52 + i * 2);
      nodes[loadId] = { class_type: "LoadImage", inputs: { image: imgPath } };
      nodes[ipaId]  = { class_type: "IPAdapter", inputs: {
        model: modelRef, ipadapter: ["50", 1],
        image: [loadId, 0], weight: perWeight, weight_type: "style transfer",
        start_at: 0, end_at: 0.5, embeds_scaling: "V only",
      }};
      modelRef = [ipaId, 0];
    });
  }

  let latentRef;
  let denoise;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    nodes["9"]  = { class_type: "LoadImage",  inputs: { image: imgPath } };
    nodes["10"] = { class_type: "VAEEncode",  inputs: { pixels: ["9", 0], vae: vaeRef } };
    latentRef = ["10", 0];
    denoise   = p.denoise ?? 0.6;
  } else {
    nodes["4"] = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
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
  nodes["6"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: vaeRef } };
  nodes["7"] = { class_type: "SaveImage", inputs: { filename_prefix: "iterator", images: ["6", 0] } };
  return nodes;
}

module.exports = { build, defaults };

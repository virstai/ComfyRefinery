'use strict';

const defaults = {
  width:              1024,
  height:             1024,
  steps:              25,
  cfgScale:           7,
  sampler:            'dpmpp_2m',
  scheduler:          'karras',
  negativePrompt:     'bad quality, blurry, watermark',
  refinerCheckpoint:  null,
  refinerSwitchAt:    0.8,
};

function build(params) {
  const p = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {
    "1":  { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
    "2":  { class_type: "CLIPTextEncodeSDXL", inputs: { text_g: p.positivePrompt, text_l: p.positivePrompt, width: p.width, height: p.height, crop_w: 0, crop_h: 0, target_width: p.width, target_height: p.height, clip: ["1", 1] } },
    "3":  { class_type: "CLIPTextEncodeSDXL", inputs: { text_g: p.negativePrompt, text_l: p.negativePrompt, width: p.width, height: p.height, crop_w: 0, crop_h: 0, target_width: p.width, target_height: p.height, clip: ["1", 1] } },
  };

  if (p.vae) {
    nodes["20"] = { class_type: "VAELoader", inputs: { vae_name: p.vae } };
  }
  const resolvedVae = p.vae ? ["20", 0] : ["1", 2];

  // IPAdapter chain:
  //   49 = IPAdapterModelLoader (load the specific file)
  //   50 = IPAdapterUnifiedLoader (patches model pipeline + auto-selects clip_vision via preset)
  //   51+i*2 = LoadImage, 52+i*2 = IPAdapter per ref image
  let modelRef = ["1", 0];
  if (p.ipAdapterImages?.length && p.adapterModel) {
    const f = p.adapterModel.toLowerCase();
    const preset = f.includes('face') ? 'PLUS FACE (portraits)'
                 : f.includes('vit-g') || f.includes('vit_g') ? 'VIT-G (medium strength)'
                 : 'PLUS (high strength)';
    nodes["49"] = { class_type: "IPAdapterModelLoader",  inputs: { ipadapter_file: p.adapterModel } };
    nodes["50"] = { class_type: "IPAdapterUnifiedLoader", inputs: { model: ["1", 0], preset, ipadapter: ["49", 0] } };
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
  let baseDenoise;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    nodes["21"] = { class_type: "LoadImage",  inputs: { image: imgPath } };
    nodes["22"] = { class_type: "VAEEncode",  inputs: { pixels: ["21", 0], vae: resolvedVae } };
    latentRef   = ["22", 0];
    baseDenoise = p.denoise ?? 0.6;
  } else {
    nodes["4"] = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latentRef   = ["4", 0];
    baseDenoise = 1.0;
  }

  if (p.refinerCheckpoint) {
    const baseSteps = Math.round(p.steps * p.refinerSwitchAt);
    nodes["5"]  = { class_type: "KSampler", inputs: { seed, steps: p.steps, cfg: p.cfgScale, sampler_name: p.sampler, scheduler: p.scheduler, denoise: baseDenoise, start_at_step: 0, end_at_step: baseSteps, return_with_leftover_noise: "enable", model: modelRef, positive: ["2", 0], negative: ["3", 0], latent_image: latentRef } };
    nodes["10"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.refinerCheckpoint } };
    nodes["11"] = { class_type: "CLIPTextEncodeSDXL", inputs: { text_g: p.positivePrompt, text_l: p.positivePrompt, width: p.width, height: p.height, crop_w: 0, crop_h: 0, target_width: p.width, target_height: p.height, clip: ["10", 1] } };
    nodes["12"] = { class_type: "CLIPTextEncodeSDXL", inputs: { text_g: p.negativePrompt, text_l: p.negativePrompt, width: p.width, height: p.height, crop_w: 0, crop_h: 0, target_width: p.width, target_height: p.height, clip: ["10", 1] } };
    nodes["13"] = { class_type: "KSampler", inputs: { seed, steps: p.steps, cfg: p.cfgScale, sampler_name: p.sampler, scheduler: p.scheduler, denoise: 1.0, start_at_step: baseSteps, end_at_step: p.steps, return_with_leftover_noise: "disable", model: ["10", 0], positive: ["11", 0], negative: ["12", 0], latent_image: ["5", 0] } };
    nodes["6"]  = { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: resolvedVae } };
  } else {
    nodes["5"] = { class_type: "KSampler", inputs: { seed, steps: p.steps, cfg: p.cfgScale, sampler_name: p.sampler, scheduler: p.scheduler, denoise: baseDenoise, model: modelRef, positive: ["2", 0], negative: ["3", 0], latent_image: latentRef } };
    nodes["6"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: resolvedVae } };
  }

  nodes["7"] = { class_type: "SaveImage", inputs: { filename_prefix: "iterator", images: ["6", 0] } };
  return nodes;
}

module.exports = { build, defaults };

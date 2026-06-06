'use strict';

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
    "2": { class_type: "CLIPTextEncode",         inputs: { text: p.positivePrompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode",         inputs: { text: p.negativePrompt, clip: ["1", 1] } },
  };

  if (p.vae) {
    nodes["8"] = { class_type: "VAELoader", inputs: { vae_name: p.vae } };
  }
  const vaeRef = p.vae ? ["8", 0] : ["1", 2];

  // IPAdapter chain: one node per reference image, each threading the model ref forward.
  // Nodes 50–51 are loaders; 52+ alternate LoadImage/IPAdapter pairs per ref.
  let modelRef = ["1", 0];
  if (p.ipAdapterImages?.length && p.adapterModel && p.clipVisionModel) {
    nodes["50"] = { class_type: "IPAdapterModelLoader", inputs: { model_name: p.adapterModel } };
    nodes["51"] = { class_type: "CLIPVisionLoader",     inputs: { clip_name: p.clipVisionModel } };
    const perWeight = (p.adapterWeight ?? 0.6) / p.ipAdapterImages.length;
    p.ipAdapterImages.forEach((ref, i) => {
      const imgPath = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
      const loadId  = String(52 + i * 2);
      const ipaId   = String(53 + i * 2);
      nodes[loadId] = { class_type: "LoadImage", inputs: { image: imgPath } };
      nodes[ipaId]  = { class_type: "IPAdapter", inputs: {
        model: modelRef, ip_adapter: ["50", 0], clip_vision: ["51", 0],
        image: [loadId, 0], weight: perWeight, start_at: 0, end_at: 1,
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

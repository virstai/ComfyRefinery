'use strict';

// Flux.1 workflow — uses FluxGuidance instead of CFG, dual text encoder (T5 + CLIP-L),
// SamplerCustomAdvanced pipeline. Supports both checkpoint and UNet/CLIP/VAE split loading.
const defaults = {
  width: 1024,
  height: 1024,
  steps: 20,
  guidance: 3.5,       // Flux uses guidance scale differently from CFG
  sampler: 'euler',
  scheduler: 'simple',
  negativePrompt: '',  // Flux doesn't use negative prompts effectively
  // For split loading (optional):
  // unetName, clipL, t5xxl, vaeName
};

function build(params) {
  const p = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {};

  if (p.unetName) {
    // Split loading: separate UNet, CLIP, VAE files
    nodes["1"]  = { class_type: "UNETLoader",     inputs: { unet_name: p.unetName, weight_dtype: "default" } };
    nodes["2"]  = { class_type: "DualCLIPLoader",  inputs: { clip_name1: p.clipL, clip_name2: p.t5xxl, type: "flux" } };
    nodes["3"]  = { class_type: "VAELoader",        inputs: { vae_name: p.vaeName } };
    return _buildGraph(nodes, p, seed, ["1", 0], ["2", 0], ["3", 0]);
  } else {
    // Single checkpoint file
    nodes["1"] = { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } };
    return _buildGraph(nodes, p, seed, ["1", 0], ["1", 1], ["1", 2]);
  }
}

function _buildGraph(nodes, p, seed, modelRef, clipRef, vaeRef) {
  const nextId = () => String(Object.keys(nodes).length + 1);

  const posId = nextId(); nodes[posId] = { class_type: "CLIPTextEncode", inputs: { text: p.positivePrompt, clip: clipRef } };

  // img2img: swap EmptyLatentImage for LoadImage → VAEEncode; set denoise on BasicScheduler
  const denoise = p.initImage ? (p.denoise ?? 0.6) : 1.0;
  let latentRef;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    const loadId = nextId(); nodes[loadId] = { class_type: "LoadImage",        inputs: { image: imgPath } };
    const encId  = nextId(); nodes[encId]  = { class_type: "VAEEncode",        inputs: { pixels: [loadId, 0], vae: vaeRef } };
    latentRef = [encId, 0];
  } else {
    const emptyId = nextId(); nodes[emptyId] = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latentRef = [emptyId, 0];
  }

  const guidId  = nextId(); nodes[guidId]  = { class_type: "FluxGuidance", inputs: { conditioning: [posId, 0], guidance: p.guidance } };

  // Redux: chain StyleModelApply nodes to inject each reference into the conditioning.
  // CLIPVisionLoader + StyleModelLoader are shared; one CLIPVisionEncode + StyleModelApply per ref.
  let condRef = [guidId, 0];
  if (p.reduxImages?.length && p.adapterModel && p.clipVisionModel) {
    const cvId = nextId(); nodes[cvId] = { class_type: "CLIPVisionLoader",  inputs: { clip_name: p.clipVisionModel } };
    const smId = nextId(); nodes[smId] = { class_type: "StyleModelLoader",  inputs: { style_model_name: p.adapterModel } };
    for (const ref of p.reduxImages) {
      const imgPath = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
      const loadId  = nextId(); nodes[loadId]  = { class_type: "LoadImage",        inputs: { image: imgPath } };
      const encId   = nextId(); nodes[encId]   = { class_type: "CLIPVisionEncode", inputs: { clip_vision: [cvId, 0], image: [loadId, 0], crop: "center" } };
      const applyId = nextId(); nodes[applyId] = { class_type: "StyleModelApply",  inputs: { conditioning: condRef, style_model: [smId, 0], clip_vision_output: [encId, 0] } };
      condRef = [applyId, 0];
    }
  }

  const noiseId = nextId(); nodes[noiseId] = { class_type: "RandomNoise",           inputs: { noise_seed: seed } };
  const basicId = nextId(); nodes[basicId] = { class_type: "BasicGuider",           inputs: { model: modelRef, conditioning: condRef } };
  const splitId = nextId(); nodes[splitId] = { class_type: "BasicScheduler",        inputs: { model: modelRef, scheduler: p.scheduler, steps: p.steps, denoise } };
  const samplId = nextId(); nodes[samplId] = { class_type: "KSamplerSelect",        inputs: { sampler_name: p.sampler } };
  const advId   = nextId(); nodes[advId]   = { class_type: "SamplerCustomAdvanced", inputs: { noise: [noiseId, 0], guider: [basicId, 0], sampler: [samplId, 0], sigmas: [splitId, 0], latent_image: latentRef } };
  const decId   = nextId(); nodes[decId]   = { class_type: "VAEDecode",             inputs: { samples: [advId, 0], vae: vaeRef } };
  const saveId  = nextId(); nodes[saveId]  = { class_type: "SaveImage",             inputs: { filename_prefix: "iterator", images: [decId, 0] } };

  return nodes;
}

module.exports = { build, defaults };

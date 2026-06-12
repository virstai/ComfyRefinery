'use strict';

// Anima — 2B parameter anime/illustration model by CircleStone Labs.
// Split loading only: UNETLoader + CLIPLoader (Qwen-3) + VAELoader (Qwen-Image).
// er_sde is the recommended sampler; available in recent ComfyUI builds or via RES4LYF.

// Anima-LLLite ControlNet node (kohya LLLite pattern: one node patches MODEL
// with a conditioning image — no separate loader/apply pair).
// ⚠ Verify class/input names against the installed pack's object_info — same
// caveat as the AnimaIPAdapter nodes.
const LLLITE_NODE = 'AnimaLLLiteLoader';
const defaults = {
  width:          1024,
  height:         1024,
  steps:          35,
  cfgScale:       5,
  sampler:        'er_sde',
  scheduler:      'simple',
  negativePrompt: '',
};

function build(params) {
  const p = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  const nodes = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: p.unetName, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: p.clipL, type: "qwen_image" } },
    "3": { class_type: "VAELoader",  inputs: { vae_name: p.vaeName } },
  };

  let modelRef = ["1", 0];
  let clipRef  = ["2", 0];

  // LoRA chain: nodes 30+i. Each LoraLoader patches both model and clip;
  // everything downstream hangs off the last link.
  (p.loras ?? []).forEach((l, i) => {
    const id = String(30 + i);
    nodes[id] = { class_type: "LoraLoader", inputs: {
      lora_name:      l.name,
      strength_model: l.weight ?? 1.0,
      strength_clip:  l.weight ?? 1.0,
      model:          modelRef,
      clip:           clipRef,
    }};
    modelRef = [id, 0];
    clipRef  = [id, 1];
  });

  nodes["4"] = { class_type: "CLIPTextEncode", inputs: { text: p.positivePrompt, clip: clipRef } };
  nodes["5"] = { class_type: "CLIPTextEncode", inputs: { text: p.negativePrompt, clip: clipRef } };

  // ControlNet (Anima-LLLite): model patch conditioned on a pose/control image.
  if (p.controlNet?.image && p.controlNet?.model) {
    const cn = p.controlNet;
    const imgPath = cn.image.subfolder ? `${cn.image.subfolder}/${cn.image.filename}` : cn.image.filename;
    nodes["70"] = { class_type: "LoadImage", inputs: { image: imgPath } };
    nodes["71"] = { class_type: LLLITE_NODE, inputs: {
      model:         modelRef,
      model_name:    cn.model,
      cond_image:    ["70", 0],
      strength:      cn.strength ?? 0.8,
      steps:         0,
      start_percent: 0.0,
      end_percent:   1.0,
    }};
    modelRef = ["71", 0];
  }

  // IP-Adapter chain: node 50 = AnimaIPAdapterLoader; nodes 51+i*3 = LoadImage,
  // 52+i*3 = AnimaSiglipeEncodeImage, 53+i*3 = AnimaIPAdapterApply per ref image.
  if (p.ipAdapterImages?.length && p.adapterModel) {
    nodes["50"] = { class_type: "AnimaIPAdapterLoader", inputs: { ipadapter_path: `models/ipadapter/${p.adapterModel}` } };
    const perWeight = (p.adapterWeight ?? 1.0) / p.ipAdapterImages.length;
    p.ipAdapterImages.forEach((ref, i) => {
      const imgPath = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
      const loadId  = String(51 + i * 3);
      const encId   = String(52 + i * 3);
      const applyId = String(53 + i * 3);
      nodes[loadId]  = { class_type: "LoadImage",               inputs: { image: imgPath } };
      nodes[encId]   = { class_type: "AnimaSiglipeEncodeImage", inputs: { image: [loadId, 0] } };
      nodes[applyId] = { class_type: "AnimaIPAdapterApply",     inputs: {
        model: modelRef, ipadapter: ["50", 0], siglip_features: [encId, 0],
        weight: perWeight, start_at: 0.0, end_at: 1.0,
      }};
      modelRef = [applyId, 0];
    });
  }

  let latentRef;
  let denoise;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    nodes["10"] = { class_type: "LoadImage", inputs: { image: imgPath } };
    nodes["11"] = { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["3", 0] } };
    latentRef = ["11", 0];
    denoise   = p.denoise ?? 0.6;
  } else {
    nodes["6"] = { class_type: "EmptyLatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latentRef = ["6", 0];
    denoise   = 1.0;
  }

  nodes["7"] = {
    class_type: "KSampler",
    inputs: {
      seed, steps: p.steps, cfg: p.cfgScale,
      sampler_name: p.sampler, scheduler: p.scheduler, denoise,
      model: modelRef, positive: ["4", 0], negative: ["5", 0], latent_image: latentRef,
    },
  };
  nodes["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  nodes["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "iterator", images: ["8", 0] } };
  return nodes;
}

module.exports = { build, defaults };

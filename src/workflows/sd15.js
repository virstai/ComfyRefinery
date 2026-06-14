'use strict';

const { applyLoraChain }       = require('./lib/loraChain');
const { buildPreprocessorNode } = require('./lib/preprocessors');

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

  let positiveRef = ["2", 0];
  let negativeRef = ["3", 0];

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

  // Tile ControlNet: structural guide from a tile image (nodes 60–62)
  if (p.tileControlNet?.image && p.tileControlNet?.model) {
    const tc = p.tileControlNet;
    const imgPath = tc.image.subfolder
      ? `${tc.image.subfolder}/${tc.image.filename}`
      : tc.image.filename;
    nodes["60"]  = { class_type: "LoadImage",   inputs: { image: imgPath } };
    nodes["60r"] = { class_type: "ImageScale",  inputs: { image: ["60", 0], width: p.width, height: p.height, upscale_method: "lanczos", crop: "disabled" } };
    nodes["61"]  = { class_type: "ControlNetLoader", inputs: { control_net_name: tc.model } };
    nodes["62"]  = { class_type: "ControlNetApplyAdvanced", inputs: {
      positive:      positiveRef,
      negative:      negativeRef,
      control_net:   ["61", 0],
      image:         ["60r", 0],
      strength:      tc.strength ?? 0.5,
      start_percent: 0.0,
      end_percent:   0.85,
    }};
    positiveRef = ["62", 0];
    negativeRef = ["62", 1];
  }

  // Pose ControlNet: standard ControlNetApplyAdvanced with a pre-extracted skeleton (nodes 63–65)
  // Chains after tile ControlNet if both are active.
  if (p.controlNet?.image && p.controlNet?.model) {
    const cn = p.controlNet;
    const imgPath = cn.image.subfolder
      ? `${cn.image.subfolder}/${cn.image.filename}`
      : cn.image.filename;
    nodes["63"] = { class_type: "LoadImage",        inputs: { image: imgPath } };
    nodes["64"] = { class_type: "ControlNetLoader", inputs: { control_net_name: cn.model } };
    nodes["65"] = { class_type: "ControlNetApplyAdvanced", inputs: {
      positive:      positiveRef,
      negative:      negativeRef,
      control_net:   ["64", 0],
      image:         ["63", 0],
      strength:      cn.strength ?? 1.0,
      start_percent: 0.0,
      end_percent:   1.0,
    }};
    positiveRef = ["65", 0];
    negativeRef = ["65", 1];
  }

  // Structural ControlNet (nodes 70–74): inline preprocessor (depth/softedge/lineart/canny)
  // for cross-model composition transfer. No init image — full style freedom for the base model.
  if (p.structuralControlNet?.image && p.structuralControlNet?.model) {
    const sc = p.structuralControlNet;
    const imgPath = sc.image.subfolder
      ? `${sc.image.subfolder}/${sc.image.filename}`
      : sc.image.filename;
    const resolution = Math.max(p.width, p.height);
    nodes["70"] = { class_type: "LoadImage",  inputs: { image: imgPath } };
    nodes["71"] = { class_type: "ImageScale", inputs: { image: ["70", 0], width: p.width, height: p.height, upscale_method: "lanczos", crop: "disabled" } };
    nodes["72"] = buildPreprocessorNode(sc.preprocessor ?? 'depth', ["71", 0], resolution);
    nodes["73"] = { class_type: "ControlNetLoader", inputs: { control_net_name: sc.model } };
    nodes["74"] = { class_type: "ControlNetApplyAdvanced", inputs: {
      positive:      positiveRef,
      negative:      negativeRef,
      control_net:   ["73", 0],
      image:         ["72", 0],
      strength:      sc.strength ?? 0.9,
      start_percent: 0.0,
      end_percent:   1.0,
    }};
    positiveRef = ["74", 0];
    negativeRef = ["74", 1];
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
      model: modelRef, positive: positiveRef, negative: negativeRef, latent_image: latentRef,
    },
  };
  nodes["6"] = { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: vaeRef } };
  nodes["7"] = { class_type: "SaveImage", inputs: { filename_prefix: "iterator", images: ["6", 0] } };
  return nodes;
}

module.exports = { build, defaults };

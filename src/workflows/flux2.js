'use strict';

// Flux 2 Dev / Klein workflow.
// Single CLIPLoader (type "flux2") covers both Mistral 3 Small (Dev) and Qwen 3 4B (Klein).
// Sampler is plain KSampler + FluxGuidance, not the SamplerCustomAdvanced pipeline used by Flux 1.
// Multi-reference conditioning is native via chained ReferenceLatent nodes — no external adapter needed.
const defaults = {
  width:    1024,
  height:   1024,
  steps:    20,
  guidance: 4.0,
  sampler:  'euler',
  scheduler: 'simple',
};

function build(params) {
  const p    = { ...defaults, ...params };
  const seed = p.seed ?? Math.floor(Math.random() * 2 ** 32);

  let counter = 0;
  const nextId = () => String(++counter);
  const nodes  = {};

  const unetId = nextId(); nodes[unetId] = { class_type: "UNETLoader",     inputs: { unet_name: p.unetName, weight_dtype: "default" } };
  const clipId = nextId(); nodes[clipId] = { class_type: "CLIPLoader",     inputs: { clip_name: p.clipName, type: "flux2" } };
  const vaeId  = nextId(); nodes[vaeId]  = { class_type: "VAELoader",      inputs: { vae_name: p.vaeName } };
  const textId = nextId(); nodes[textId] = { class_type: "CLIPTextEncode", inputs: { text: p.positivePrompt, clip: [clipId, 0] } };
  const guidId = nextId(); nodes[guidId] = { class_type: "FluxGuidance",   inputs: { conditioning: [textId, 0], guidance: p.guidance } };

  // Chain ReferenceLatent nodes for multi-reference conditioning (native to Flux 2).
  // Each ref: LoadImage → VAEEncode → ReferenceLatent.latent
  let condRef = [guidId, 0];
  if (p.referenceImages?.length) {
    for (const ref of p.referenceImages) {
      const imgPath  = ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename;
      const loadId   = nextId(); nodes[loadId]  = { class_type: "LoadImage",              inputs: { image: imgPath } };
      const scaleId  = nextId(); nodes[scaleId] = { class_type: "ImageScaleToTotalPixels", inputs: { image: [loadId, 0], upscale_method: "lanczos", megapixels: 1.0, resolution_steps: 64 } };
      const encId    = nextId(); nodes[encId]   = { class_type: "VAEEncode",              inputs: { pixels: [scaleId, 0], vae: [vaeId, 0] } };
      const refId    = nextId(); nodes[refId]   = { class_type: "ReferenceLatent",        inputs: { conditioning: condRef, latent: [encId, 0] } };
      condRef = [refId, 0];
    }
  }

  // Flux 2 does not use negative prompts — zero out the text conditioning.
  const zeroId = nextId(); nodes[zeroId] = { class_type: "ConditioningZeroOut", inputs: { conditioning: [textId, 0] } };

  let latentRef;
  if (p.initImage) {
    const imgPath = p.initImage.subfolder
      ? `${p.initImage.subfolder}/${p.initImage.filename}`
      : p.initImage.filename;
    const loadId = nextId(); nodes[loadId] = { class_type: "LoadImage", inputs: { image: imgPath } };
    const encId  = nextId(); nodes[encId]  = { class_type: "VAEEncode", inputs: { pixels: [loadId, 0], vae: [vaeId, 0] } };
    latentRef = [encId, 0];
  } else {
    const emptyId = nextId(); nodes[emptyId] = { class_type: "EmptyFlux2LatentImage", inputs: { width: p.width, height: p.height, batch_size: 1 } };
    latentRef = [emptyId, 0];
  }

  const sampId = nextId(); nodes[sampId] = { class_type: "KSampler", inputs: {
    seed, steps: p.steps, cfg: 1, sampler_name: p.sampler, scheduler: p.scheduler,
    denoise: p.initImage ? (p.denoise ?? 0.6) : 1.0,
    model: [unetId, 0], positive: condRef, negative: [zeroId, 0], latent_image: latentRef,
  }};
  const decId  = nextId(); nodes[decId]  = { class_type: "VAEDecode", inputs: { samples: [sampId, 0], vae: [vaeId, 0] } };
  const saveId = nextId(); nodes[saveId] = { class_type: "SaveImage", inputs: { filename_prefix: "iterator", images: [decId, 0] } };

  return nodes;
}

module.exports = { build, defaults };

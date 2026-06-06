'use strict';

const profiles = {
  sd15:         require('./sd15'),
  sdxl:         require('./sdxl'),
  flux:         require('./flux'),
  flux2:        require('./flux2'),
  sd3:          require('./sd3'),
  chroma:       require('./chroma'),
  anima:        require('./anima'),
  wanvideo:     require('./wanvideo'),
  hunyuanvideo: require('./hunyuanvideo'),
  ltxvideo:     require('./ltxvideo'),
  cogvideox:    require('./cogvideox'),
};

const ARCH_META = {
  sd15: {
    label:       'SD 1.5 / SD 2.x',
    loadingMode: 'checkpoint',
    fields:      { checkpoint: true, vae: true, cfgScale: true, negativePrompt: true, adapterModel: 'ipa', clipVisionModel: true, adapterWeight: true },
  },
  sdxl: {
    label:       'SDXL',
    loadingMode: 'checkpoint',
    fields:      { checkpoint: true, vae: true, cfgScale: true, negativePrompt: true, refiner: true, adapterModel: 'ipa', clipVisionModel: true, adapterWeight: true },
  },
  flux: {
    label:       'Flux.1',
    loadingMode: 'split-or-checkpoint',
    fields:      { checkpoint: true, unetName: true, clipL: true, t5xxl: true, vaeName: true, guidance: true, adapterModel: 'redux', clipVisionModel: true },
  },
  flux2: {
    label:       'Flux 2 (Dev / Klein)',
    loadingMode: 'split',
    fields:      { unetName: true, clipName: true, vaeName: true, guidance: true },
  },
  sd3: {
    label:       'SD 3 / SD 3.5',
    loadingMode: 'checkpoint',
    fields:      { checkpoint: true, vae: true, cfgScale: true, negativePrompt: true },
  },
  chroma: {
    label:       'ChromaHD',
    loadingMode: 'split',
    fields:      { unetName: true, clipName: true, vaeName: true, guidance: true, negativePrompt: true },
    notes:       'No custom nodes required. Needs a T5 encoder (e.g. t5xxl_flan_latest_float8_e4m3fn_scaled_stochastic.safetensors) in the text_encoders folder.',
  },
  anima: {
    label:       'Anima',
    loadingMode: 'split',
    fields:      { unetName: true, clipL: true, vaeName: true, cfgScale: true },
    notes:       'Requires Qwen-3 text encoder (qwen_3_06b_base.safetensors) and Qwen-Image VAE. The er_sde sampler is available in recent ComfyUI builds or via the RES4LYF custom node pack.',
  },
  wanvideo: {
    label:       'WanVideo (Wan 2.2)',
    loadingMode: 'split',
    videoArch:   true,
    fields:      {
      unetName:          true,
      unetName2:         true,
      modelQuantization: ['default', 'fp8_e4m3fn', 'fp8_e4m3fn_fast', 'fp8_e5m2'],
      clipName:          true,
      vaeName:           true,
      guidance:          true,
    },
    fieldHints:  {
      unetName:  'High-noise expert — e.g. wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
      unetName2: 'Low-noise expert — e.g. wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors (leave blank for 5B TI2V)',
    },
    fieldLabels: {
      modelQuantization: 'Model quantization',
    },
    notes:       'No custom nodes required — uses native ComfyUI nodes. Primary mode is image-to-video (I2V). 14B MoE: set both UNet fields (two-sampler cascade). 5B TI2V: first UNet field only. Pre-quantized models (e.g. _fp8_scaled) should use "default" quantization.',
  },
  hunyuanvideo: {
    label:       'HunyuanVideo',
    loadingMode: 'split',
    videoArch:   true,
    fields:      { unetName: true, clipName: true, vaeName: true, guidance: true },
    notes:       'Main model goes in models/diffusion_models/ (not checkpoints). Requires two text encoders: clip_l.safetensors and llava_llama3_fp8_scaled.safetensors — set CLIP to clip_l. Has native ComfyUI support (no custom nodes needed on recent ComfyUI).',
  },
  ltxvideo: {
    label:       'LTX-Video',
    loadingMode: 'checkpoint',
    videoArch:   true,
    fields:      { checkpoint: true, clipName: true, guidance: true },
    notes:       'Checkpoint goes in models/checkpoints/. Text encoder (T5-XXL or Gemma 3 for LTX-2.3) goes in models/text_encoders/. Native ComfyUI support built-in; ComfyUI-LTXVideo custom nodes add advanced workflow features.',
  },
  cogvideox: {
    label:       'CogVideoX',
    loadingMode: 'checkpoint',
    videoArch:   true,
    fields:      { checkpoint: true, vae: true, clipName: true, cfgScale: true },
    notes:       'Requires kijai/ComfyUI-CogVideoXWrapper. The wrapper auto-downloads models to models/CogVideo/. T5 encoder goes in models/clip/. Available in 2B, 5B, and 5B-I2V variants — no 9B variant exists.',
  },
};

function buildWorkflow(modelConfig, generationParams) {
  const { architecture } = modelConfig;
  if (!architecture) throw new Error('Model config is missing architecture.');
  const profile = profiles[architecture];
  if (!profile) throw new Error(`Unknown architecture "${architecture}". Valid: ${Object.keys(profiles).join(', ')}`);
  // Strip null/undefined so each profile's defaults fill in properly
  const merged = { ...modelConfig, ...generationParams };
  const params = Object.fromEntries(Object.entries(merged).filter(([, v]) => v != null));
  return { workflow: profile.build(params), architecture };
}

function getDefaults(architecture) {
  const profile = profiles[architecture];
  if (!profile) throw new Error(`Unknown architecture: ${architecture}`);
  return { ...profile.defaults };
}

module.exports = {
  buildWorkflow,
  getDefaults,
  architectures: Object.keys(profiles),
  archMeta: ARCH_META,
};

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
  zimage:       require('./zimage'),
  krea2:        require('./krea2'),
};

const ARCH_META = {
  sd15: {
    label:        'SD 1.5 / SD 2.x',
    loadingMode:  'checkpoint',
    capabilities: { lora: true, adapter: true, controlNet: true, tileControlNet: true, structuralControlNet: true },
    fields:       { checkpoint: true, vae: true, cfgScale: true, negativePrompt: true, adapterModel: 'ipa', adapterWeight: true, controlNetModel: 'controlnet', tileControlNetModel: 'controlnet', structuralControlNetModel: 'controlnet' },
    notes:        'Tile and structural ControlNet require comfyui_controlnet_aux (Fannovel16) for preprocessor nodes. Structural CN enables cross-model composition transfer — use a CN model matching the checkpoint prediction type (eps vs v-pred).',
  },
  sdxl: {
    label:        'SDXL',
    loadingMode:  'checkpoint',
    capabilities: { lora: true, adapter: true, controlNet: true, tileControlNet: true, structuralControlNet: true },
    fields:       { checkpoint: true, vae: true, cfgScale: true, negativePrompt: true, refiner: true, adapterModel: 'ipa', adapterWeight: true, controlNetModel: 'controlnet', tileControlNetModel: 'controlnet', structuralControlNetModel: 'controlnet' },
    notes:        'Tile and structural ControlNet require comfyui_controlnet_aux (Fannovel16) for preprocessor nodes. For Illustrious XL checkpoints use the MIC-Lab eps-trained CNs (illustriousXLv0.1_depth_midas_fp16.safetensors, illustriousXLv0.1_Softedge_fp16.safetensors) — the windsingai tile model is v-pred only and will produce washed-out output with eps Illustrious v0.1.',
  },
  flux: {
    label:        'Flux.1',
    loadingMode:  'split-or-checkpoint',
    capabilities: { lora: true, adapter: true, controlNet: false },
    fields:       { checkpoint: true, unetName: true, clipL: true, t5xxl: true, vaeName: true, guidance: true, adapterModel: 'redux', clipVisionModel: true },
  },
  flux2: {
    label:        'Flux 2 (Dev / Klein)',
    loadingMode:  'split',
    capabilities: { lora: true, adapter: true, controlNet: false },
    fields:       { unetName: true, clipName: true, vaeName: true, guidance: true },
  },
  sd3: {
    label:        'SD 3 / SD 3.5',
    loadingMode:  'checkpoint',
    capabilities: { lora: true, adapter: false, controlNet: false },
    fields:       { checkpoint: true, vae: true, cfgScale: true, negativePrompt: true },
  },
  chroma: {
    label:        'ChromaHD',
    loadingMode:  'split',
    capabilities: { lora: true, adapter: false, controlNet: false },
    fields:       { unetName: true, clipName: true, vaeName: true, guidance: true, negativePrompt: true },
    notes:        'No custom nodes required. Needs a T5 encoder (e.g. t5xxl_flan_latest_float8_e4m3fn_scaled_stochastic.safetensors) in the text_encoders folder.',
  },
  anima: {
    label:        'Anima',
    loadingMode:  'split',
    capabilities: { lora: true, adapter: false, controlNet: true },
    fields:       { unetName: true, clipL: true, vaeName: true, cfgScale: true, negativePrompt: true, adapterModel: 'ipa', adapterWeight: true, controlNetModel: 'controlnet' },
    notes:        'Requires Qwen-3 text encoder (qwen_3_06b_base.safetensors) and Qwen-Image VAE. The er_sde sampler is available in recent ComfyUI builds or via the RES4LYF custom node pack. IP-Adapter support is implemented but the adapter weights are not yet publicly released (still in training) — check the comfyui-anima-ipadapter repo for release announcements. ControlNet via Anima-LLLite is supported on generate steps (pose pre-pass); it needs two custom node packs cloned into custom_nodes/: kohya-ss/ComfyUI-Anima-LLLite (no extra deps; LLLite .safetensors weights go in models/controlnet/) and Fannovel16/comfyui_controlnet_aux (pip install -r requirements.txt; DWPose detector models auto-download on first use).',
  },
  wanvideo: {
    label:        'WanVideo (Wan 2.2)',
    loadingMode:  'split',
    capabilities: { lora: false, adapter: false, controlNet: false },
    videoArch:    true,
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
    label:        'HunyuanVideo',
    loadingMode:  'split',
    capabilities: { lora: false, adapter: false, controlNet: false },
    videoArch:    true,
    fields:       { unetName: true, clipName: true, vaeName: true, guidance: true },
    notes:       'Main model goes in models/diffusion_models/ (not checkpoints). Requires two text encoders: clip_l.safetensors and llava_llama3_fp8_scaled.safetensors — set CLIP to clip_l. Has native ComfyUI support (no custom nodes needed on recent ComfyUI).',
  },
  ltxvideo: {
    label:        'LTX-Video',
    loadingMode:  'checkpoint',
    capabilities: { lora: false, adapter: false, controlNet: false },
    videoArch:    true,
    fields:       { checkpoint: true, clipName: 'always', distilledLoraName: 'lora', enableAudio: 'toggle', guidance: true },
    fieldHints:   {
      clipName:          'Text encoder — e.g. gemma_3_12B_it_fp4_mixed.safetensors (models/text_encoders/)',
      distilledLoraName: 'Optional distilled guidance LoRA — e.g. ltx-2.3-22b-distilled-lora-384.safetensors',
      enableAudio:       'Generate audio alongside video. No extra model download needed — audio VAE is embedded in the checkpoint.',
    },
    notes:       'Checkpoint goes in models/checkpoints/. Text encoder (Gemma 3 for LTX-2.3) goes in models/text_encoders/. Distilled guidance LoRA goes in models/loras/. Uses built-in ComfyUI nodes (LTXAVTextEncoderLoader, LTXVConditioning, etc.) — no custom node pack required.',
  },
  cogvideox: {
    label:        'CogVideoX',
    loadingMode:  'checkpoint',
    capabilities: { lora: false, adapter: false, controlNet: false },
    videoArch:    true,
    fields:       { checkpoint: true, vae: true, clipName: true, cfgScale: true },
    notes:       'Requires kijai/ComfyUI-CogVideoXWrapper. The wrapper auto-downloads models to models/CogVideo/. T5 encoder goes in models/clip/. Available in 2B, 5B, and 5B-I2V variants — no 9B variant exists.',
  },
  zimage: {
    label:        'Z-Image',
    loadingMode:  'split',
    capabilities: { lora: true, adapter: false, controlNet: false },
    fields:       { unetName: true, clipName: true, vaeName: true, cfgScale: true, negativePrompt: true },
    notes:        'No custom nodes required — uses standard ComfyUI nodes. Diffusion model goes in models/diffusion_models/, text encoder (Qwen 3 4B) in models/text_encoders/, VAE in models/vae/.',
  },
  krea2: {
    label:        'Krea 2',
    loadingMode:  'split',
    capabilities: { lora: true, adapter: false, controlNet: false },
    fields:       { unetName: true, clipName: true, vaeName: true, cfgScale: true, negativePrompt: true },
    notes:        'No custom nodes required, but needs a recent ComfyUI build with Krea 2 support. Diffusion model goes in models/diffusion_models/, Qwen3-VL-4B text encoder in models/text_encoders/, Qwen-Image VAE in models/vae/. Defaults target Krea 2 Turbo (8 steps, CFG 1.0); for Krea 2 Raw set steps ~52 and CFG 3.0–3.5. LoRAs use LoraLoaderModelOnly (DiT only, text encoder untouched).',
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

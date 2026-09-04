'use strict';

const { applyDevicePlacement } = require('./lib/devicePlacement');

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
  minimaxh3:    require('./minimaxh3'),
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
    dimMultiple:  16,
    followInputAspect: true,
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
    dimMultiple:  16,
    followInputAspect: true,
    fields:       { unetName: true, clipName: true, vaeName: true, guidance: true },
    notes:       'Main model goes in models/diffusion_models/ (not checkpoints). Requires two text encoders: clip_l.safetensors and llava_llama3_fp8_scaled.safetensors — set CLIP to clip_l. Has native ComfyUI support (no custom nodes needed on recent ComfyUI).',
  },
  ltxvideo: {
    label:        'LTX-Video 2.3',
    loadingMode:  'checkpoint',
    // LoRAs are DiT-only (LoraLoaderModelOnly) — video steps pass `loras`, Film segments `segment.loras`.
    capabilities: { lora: true, adapter: false, controlNet: false },
    videoArch:    true,
    // The two-stage recipe samples at half size and doubles it, so output sizes are 2 × the /32 latent grid.
    dimMultiple:  64,
    followInputAspect: true,
    // Eligible as a Film project model (continue mode only — no reference-to-video).
    film:         true,
    filmFrames:   121,
    // Output sizes (short edge ≤ 1088, /64 grid). 1024×576 matches the MiniMax H3
    // "lighter" preset for side-by-side comparisons; 1920×1088 is the model's 1080p size.
    filmFormats: [
      { aspect: '16:9', width: 1024, height: 576,  note: 'default' },
      { aspect: '16:9', width: 1280, height: 704,  note: '720p' },
      { aspect: '16:9', width: 1920, height: 1088, note: '1080p, heavy' },
      { aspect: '21:9', width: 1344, height: 576 },
      { aspect: '4:3',  width: 1024, height: 768 },
      { aspect: '9:16', width: 576,  height: 1024, note: 'default' },
      { aspect: '9:16', width: 704,  height: 1280, note: '720p' },
      { aspect: '9:16', width: 1088, height: 1920, note: '1080p, heavy' },
      { aspect: '3:4',  width: 768,  height: 1024 },
      { aspect: '1:1',  width: 768,  height: 768 },
      { aspect: '1:1',  width: 1024, height: 1024 },
    ],
    fields:       {
      checkpoint:        true,
      clipName:          'always',
      distilledLoraName: 'lora',
      upscaleModel:      'latentUpscale',
      samplingMode:      ['distilled', 'full'],
      enableAudio:       'toggle',
      vae:               true,
      audioVaeName:      'always',
      guidance:          true,
      negativePrompt:    true,
    },
    fieldHints:   {
      vae:               'Optional standalone video VAE (models/vae/) instead of the one inside the checkpoint — extract it with `node scripts/extract-safetensors.js <checkpoint> models/vae/ltx-2.3-video-vae.safetensors --prefix vae.=`. Lets the device dropdown place decoding on another GPU so the 24 GB DiT can stay fully resident.',
      audioVaeName:      'Optional standalone audio VAE + vocoder (models/vae/) — `node scripts/extract-safetensors.js <checkpoint> models/vae/ltx-2.3-audio-vae.safetensors --prefix audio_vae. --prefix vocoder.`. Blank = loaded from the checkpoint (same GPU as the DiT).',
      checkpoint:        'Full LTX-2.3 checkpoint (models/checkpoints/) — the official ltx-2.3-22b-dev-fp8.safetensors or a fine-tune in the same layout such as Sulphur 2 (sulphur_dev_fp8mixed.safetensors). Video VAE, audio VAE and vocoder are inside the file.',
      clipName:          'Gemma 3 12B text encoder (models/text_encoders/) — gemma_3_12B_it_fp4_mixed.safetensors, or gemma_3_12B_it_fp8_scaled.safetensors where fp4 is unsupported.',
      distilledLoraName: 'Distilled LoRA (models/loras/) — e.g. ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors (Sulphur 2 repo) or ltx-2.3-22b-distilled-lora-384-1.1.safetensors (Lightricks). Drives the distilled sampling mode and is required for the two-stage refine.',
      upscaleModel:      'Spatial latent upscaler (models/latent_upscale_models/) — ltx-2.3-spatial-upscaler-x2-1.1.safetensors. When set, clips are sampled at half size and refined at full size (the official recipe; much lighter on VRAM). Needs the distilled LoRA.',
      samplingMode:      'distilled: the distilled LoRA drives sampling (cfg 1, 8 steps — fast). full: the base model samples with CFG and the negative prompt (30+ steps, slower; the distilled LoRA is only used for the refine). Defaults to distilled when a LoRA is set.',
      enableAudio:       'Generate audio alongside video. No extra model download needed — the audio VAE is embedded in the checkpoint.',
    },
    fieldLabels:  {
      distilledLoraName: 'Distilled LoRA',
      upscaleModel:      'Spatial upscaler (two-stage)',
      samplingMode:      'Sampling mode',
      audioVaeName:      'Audio VAE file (optional)',
    },
    notes:       'Native ComfyUI nodes only, no custom pack. Checkpoint in models/checkpoints/, Gemma 3 text encoder in models/text_encoders/, distilled LoRA in models/loras/, spatial upscaler in models/latent_upscale_models/. Graph follows the official LTX-2.3 templates: half-size sampling → ×2 latent upscale → short LCM refine, tiled decode, image-to-video via LTXVImgToVideoInplace. Frame counts snap to 8n+1 (121 ≈ 5 s at 24 fps). Negative prompt applies in full sampling mode (cfg > 1).',
  },
  minimaxh3: {
    label:           'MiniMax H3 (Hailuo 3)',
    loadingMode:     'split',
    // LoRAs (DiT-only, LoraLoaderModelOnly) — workflow video steps via `loras`, Film segments per segment
    capabilities:    { lora: true, adapter: false, controlNet: false },
    videoArch:       true,
    dimMultiple:  32,
    followInputAspect: true,
    referenceToVideo: true,
    maxReferences:    9,
    // Ref2VA also takes short reference clips (<Video k>, with soundtrack) and
    // standalone reference audio (<Audio j>) — see src/workflows/minimaxh3.js.
    referenceVideos:  3,
    referenceAudios:  3,
    // MiniMaxH3ReferenceToVideo requires audio_vae, so R2V needs both files set.
    referenceToVideoRequires: ['refUnetName', 'audioVaeName'],
    // FL2VA accepts a last_frame (bridge to a target keyframe).
    lastFrame:        true,
    // Eligible as a Film project model (src/services/filmRunner.js).
    film:             true,
    filmFrames:       124,
    // Film format presets (FilmSetup picks one; see filmFormats()). The open
    // weights cap the short edge at 768 and want a /32 grid; the "lighter"
    // 1024×576 pair is the resolution that decodes cleanly on ROCm and follows
    // prompts better (docs/arch/minimaxh3.md).
    filmFormats: [
      { aspect: '16:9', width: 1344, height: 768,  note: 'native' },
      { aspect: '16:9', width: 1024, height: 576,  note: 'lighter' },
      { aspect: '21:9', width: 1344, height: 576 },
      { aspect: '3:2',  width: 1152, height: 768 },
      { aspect: '4:3',  width: 1024, height: 768 },
      { aspect: '9:16', width: 768,  height: 1344, note: 'native' },
      { aspect: '9:16', width: 576,  height: 1024, note: 'lighter' },
      { aspect: '9:21', width: 576,  height: 1344 },
      { aspect: '2:3',  width: 768,  height: 1152 },
      { aspect: '3:4',  width: 768,  height: 1024 },
      { aspect: '1:1',  width: 768,  height: 768 },
    ],
    fields:      {
      unetName:             true,
      refUnetName:          true,
      clipName:             true,
      vaeName:              true,
      audioVaeName:         true,
      distilledLoraName:    'lora',
      refDistilledLoraName: 'lora',
    },
    fieldHints:  {
      unetName:             'FL2VA model (T2V + I2V) — e.g. minimax_h3_fl2va_pruned_int8_convrot.safetensors',
      refUnetName:          'Optional Ref2VA model (reference-to-video) — e.g. minimax_h3_ref2va_pruned_int8_convrot.safetensors. Uploaded reference images route to it automatically.',
      clipName:             'Qwen3-VL-32B text encoder (models/text_encoders/) — qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors on NVIDIA; on AMD/ROCm use qwen3vl_32b_minimax_h3_int8_convrot.safetensors, since the nvfp4 file yields NaN conditioning there (the prompt is ignored).',
      vaeName:              'Video VAE — minimax_h3_video_vae_fp16.safetensors',
      audioVaeName:         'Audio VAE — minimax_h3_audio_vae_fp32.safetensors. Required for reference-to-video and Film projects; leave blank to skip audio on T2V/I2V.',
      distilledLoraName:    'Optional 8-step turbo LoRA for FL2VA (~2× faster, small quality cost). Step count defaults to 8 automatically while active — clear this field for maximum quality at 20 steps.',
      refDistilledLoraName: 'Optional 4-step turbo LoRA for Ref2VA. Step count defaults to 4 automatically while active.',
    },
    fieldLabels: {
      unetName:             'FL2VA UNet file',
      refUnetName:          'Ref2VA UNet file',
      vaeName:              'Video VAE file',
      audioVaeName:         'Audio VAE file',
      distilledLoraName:    'Turbo LoRA (FL2VA)',
      refDistilledLoraName: 'Turbo LoRA (Ref2VA)',
    },
    notes:       'Native ComfyUI nodes only, requires ComfyUI ≥ 0.30.0. Model files go in models/diffusion_models/, text encoder in models/text_encoders/, both VAEs in models/vae/, turbo LoRAs in models/loras/. Generates video with native stereo audio in one pass (audio VAE required for sound). Guidance-free — no negative prompt or CFG. Frame counts snap to 17k+5 (73 ≈ 3s at 24fps); native resolution 1344×768.',
  },
  cogvideox: {
    label:        'CogVideoX',
    loadingMode:  'checkpoint',
    capabilities: { lora: false, adapter: false, controlNet: false },
    videoArch:    true,
    dimMultiple:  8,
    // CogVideoX weights are fixed-resolution (720×480) — never follow the input image's ratio.
    followInputAspect: false,
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
  return { workflow: applyDevicePlacement(profile.build(params), modelConfig), architecture };
}

function getDefaults(architecture) {
  const profile = profiles[architecture];
  if (!profile) throw new Error(`Unknown architecture: ${architecture}`);
  return { ...profile.defaults };
}

// Standard aspect ratios offered when an arch has no explicit filmFormats list:
// each is fitted to the arch's default pixel budget, with the long edge capped
// at the default long edge and the short edge at the default short edge, then
// snapped to the arch's dimension grid.
const FILM_ASPECTS = [
  ['16:9', 16 / 9], ['21:9', 21 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3],
  ['9:16', 9 / 16], ['9:21', 9 / 21], ['2:3', 2 / 3], ['3:4', 3 / 4],
  ['1:1', 1],
];

function orientationOf(width, height) {
  return width === height ? 'square' : width > height ? 'landscape' : 'portrait';
}

// Film format presets for an architecture: [{ aspect, width, height, orientation, label, note? }].
// Explicit per-arch lists (ARCH_META[arch].filmFormats) win; otherwise the list is
// derived from the arch's defaults so any future Film-capable arch gets sensible options.
function filmFormats(architecture) {
  const meta = ARCH_META[architecture] ?? {};
  let list = meta.filmFormats;
  if (!list) {
    const d = getDefaults(architecture);
    const mult   = meta.dimMultiple ?? 16;
    const budget = d.width * d.height;
    const longMax  = Math.max(d.width, d.height);
    const shortMax = Math.min(d.width, d.height);
    const snap = v => Math.max(mult, Math.round(v / mult) * mult);
    list = FILM_ASPECTS.map(([aspect, ratio]) => {
      let h = Math.sqrt(budget / ratio);
      let w = h * ratio;
      const scale = Math.min(1, longMax / Math.max(w, h), shortMax / Math.min(w, h));
      w *= scale; h *= scale;
      return { aspect, width: snap(w), height: snap(h) };
    });
  }
  return list.map(f => ({
    ...f,
    orientation: orientationOf(f.width, f.height),
    label: `${f.aspect} · ${f.width}×${f.height}${f.note ? ` (${f.note})` : ''}`,
  }));
}

module.exports = {
  buildWorkflow,
  getDefaults,
  filmFormats,
  architectures: Object.keys(profiles),
  archMeta: ARCH_META,
};

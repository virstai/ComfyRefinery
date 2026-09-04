'use strict';

const { applyModelOnlyLoraChain } = require('./lib/loraChain');

// LTX-2.3 (22B audio-video) — native ComfyUI nodes only.
//
// The graph follows ComfyUI's own LTX-2.3 templates and the Sulphur 2 fine-tune's
// published workflows (both use the same recipe):
//
//   stage 1  sample at half resolution — SamplerCustomAdvanced with a CFGGuider,
//            LTXVScheduler sigmas, an optional distilled LoRA, video (+ audio) latents
//   stage 2  (when a spatial latent upscaler is set) LTXVLatentUpsampler ×2, then a
//            short LCM refine with the distilled LoRA at 0.5 and cfg 1 — the stage-1
//            audio latent is carried through untouched
//   decode   VAEDecodeTiled (memory-safe for long clips) + audio VAE decode → CreateVideo
//
// Image-to-video uses LTXVPreprocess + LTXVImgToVideoInplace (the first frame is
// written into the latent in place) rather than LTXVAddGuide, at 0.7 for stage 1
// and 1.0 for the refine — the same strengths the templates use. Without an
// upscaler the whole clip is sampled once at full resolution (strength 1.0).
//
// Two sampling recipes, `samplingMode`:
//   distilled  the distilled LoRA drives stage 1 (0.7): cfg 1, 8 steps, LTXVScheduler
//              max_shift 4 / base_shift 1.5 / terminal 0.1, euler_ancestral_cfg_pp
//   full       the base model drives stage 1: cfg `guidance` (3.6), 30 steps
//              (Sulphur's workflow uses 50), max_shift 2.72 / base_shift 0.8 /
//              terminal 0, euler_ancestral; the distilled LoRA is only used for
//              the refine — so `full` still needs it when an upscaler is set.
// `samplingMode` defaults to `distilled` when a distilled LoRA is configured.

const defaults = {
  width:    1024,
  height:   576,
  frames:   121,     // ≈ 5 s at 24 fps; LTX frame counts are 8n+1
  fps:      24,
  steps:    30,      // full recipe; the distilled recipe defaults to 8
  guidance: 3.6,
  sampler:  'euler_ancestral',
  negativePrompt: 'pc game, console game, video game, cartoon, childish, ugly',
};

const RECIPES = {
  distilled: { steps: 8,  cfg: 1,    sampler: 'euler_ancestral_cfg_pp', maxShift: 4,    baseShift: 1.5, terminal: 0.1, loraStrength: 0.7, refineSigmas: '0.85, 0.7250, 0.4219, 0.0' },
  full:      { steps: 30, cfg: null, sampler: 'euler_ancestral',        maxShift: 2.72, baseShift: 0.8, terminal: 0,   loraStrength: 0,   refineSigmas: '0.85, 0.7933, 0.68, 0.51, 0.2833, 0.0' },
};

const REFINE_LORA_STRENGTH = 0.5;
const I2V_STAGE1_STRENGTH  = 0.7;
const IMG_COMPRESSION      = 18;
const LATENT_GRID          = 32;

const snap32 = v => Math.max(LATENT_GRID, Math.floor(v / LATENT_GRID) * LATENT_GRID);

function build(params) {
  const {
    checkpoint, clipName, distilledLoraName, upscaleModel, enableAudio = false,
    vae = null,            // optional external video VAE file (models/vae/) — see scripts/extract-safetensors.js
    audioVaeName = null,   // optional external audio VAE file (models/vae/)
    positivePrompt = '',
    negativePrompt = defaults.negativePrompt,
    width     = defaults.width,
    height    = defaults.height,
    frames    = defaults.frames,
    fps       = defaults.fps,
    seed      = Math.floor(Math.random() * 2 ** 32),
    inputRef  = null,
    isI2V     = false,
    loras     = [],
  } = params;

  const samplingMode = params.samplingMode || (distilledLoraName ? 'distilled' : 'full');
  const recipe = RECIPES[samplingMode];
  if (!recipe) throw new Error(`ltxvideo: unknown samplingMode "${samplingMode}" — use "distilled" or "full"`);
  if (samplingMode === 'distilled' && !distilledLoraName) {
    throw new Error('ltxvideo: the distilled sampling mode needs a distilled LoRA on the model — set one, or switch the model to full sampling');
  }
  const twoStage = !!upscaleModel;
  if (twoStage && !distilledLoraName) {
    throw new Error('ltxvideo: the two-stage refine (spatial upscaler) needs the distilled LoRA on the model — set one, or clear the upscaler');
  }

  const steps    = params.steps    ?? recipe.steps;
  const sampler  = params.sampler  ?? recipe.sampler;
  const cfg      = recipe.cfg      ?? (params.guidance ?? defaults.guidance);

  // LTX latent temporal factor is 8, so valid frame counts are 1 + N×8 (1, 9, 17 … 97, 105, 113, 121…)
  const validFrames = Math.max(1, Math.round((frames - 1) / 8) * 8 + 1);

  // Output size. With the upscaler the clip is sampled at half size and doubled,
  // so the final size is twice a /32 grid (archMeta.dimMultiple is 64).
  const outW = twoStage ? snap32(width / 2) * 2 : snap32(width);
  const outH = twoStage ? snap32(height / 2) * 2 : snap32(height);
  const s1W  = twoStage ? outW / 2 : outW;
  const s1H  = twoStage ? outH / 2 : outH;

  const imgPath = inputRef
    ? (inputRef.subfolder ? `${inputRef.subfolder}/${inputRef.filename}` : inputRef.filename)
    : null;

  let n = 0;
  const id = () => String(++n);
  const nodes = {};

  // ── Loaders ────────────────────────────────────────────────────────────────
  // LTXAVTextEncoderLoader loads Gemma 3 (text_encoder) and takes the checkpoint
  // for the embedding connectors — CLIPLoader type "ltxv" is the wrong loader here.
  const ckptId = id();
  const clipId = id();
  nodes[ckptId] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } };
  nodes[clipId] = { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: clipName, ckpt_name: checkpoint, device: 'default' } };
  const baseModel = [ckptId, 0];

  // The VAEs live inside the checkpoint. Loading them from standalone files
  // instead (extracted with scripts/extract-safetensors.js) lets `devices.vae` /
  // `devices.audioVae` place them on another GPU — the DiT alone fills a 30 GB
  // card, and ROCm's partial-unload path is where the in-checkpoint variant died.
  let vaeRef = [ckptId, 2];
  if (vae) {
    const vaeId = id();
    nodes[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: vae } };
    vaeRef = [vaeId, 0];
  }

  // Per-step / per-segment LoRAs (DiT only) sit under the distilled LoRA on both stages.
  const extraLoras = (loras ?? []).filter(l => l?.name);
  let sharedModel = baseModel;
  if (extraLoras.length) {
    sharedModel = applyModelOnlyLoraChain(nodes, sharedModel, extraLoras, () => id());
  }

  // Distilled LoRA per stage (0 = not applied).
  function modelWithDistilled(strength) {
    if (!distilledLoraName || !strength) return sharedModel;
    const loraId = id();
    nodes[loraId] = { class_type: 'LoraLoaderModelOnly', inputs: { model: sharedModel, lora_name: distilledLoraName, strength_model: strength } };
    return [loraId, 0];
  }

  // ── Conditioning ───────────────────────────────────────────────────────────
  const posId = id();
  const negId = id();
  const condId = id();
  nodes[posId]  = { class_type: 'CLIPTextEncode',   inputs: { clip: [clipId, 0], text: positivePrompt } };
  nodes[negId]  = { class_type: 'CLIPTextEncode',   inputs: { clip: [clipId, 0], text: negativePrompt ?? '' } };
  nodes[condId] = { class_type: 'LTXVConditioning', inputs: { positive: [posId, 0], negative: [negId, 0], frame_rate: fps } };
  const posRef = [condId, 0];
  const negRef = [condId, 1];

  // ── Start image (I2V) ──────────────────────────────────────────────────────
  // Scaled to the output frame (centre crop absorbs any aspect mismatch), then
  // LTXVPreprocess applies the light JPEG-style compression the model was
  // trained on. The in-place node resizes to whichever latent it is given.
  let imageRef = null;
  if (isI2V && imgPath) {
    const imgId   = id();
    const scaleId = id();
    const prepId  = id();
    nodes[imgId]   = { class_type: 'LoadImage',      inputs: { image: imgPath } };
    nodes[scaleId] = { class_type: 'ImageScale',     inputs: { image: [imgId, 0], upscale_method: 'lanczos', width: outW, height: outH, crop: 'center' } };
    nodes[prepId]  = { class_type: 'LTXVPreprocess', inputs: { image: [scaleId, 0], img_compression: IMG_COMPRESSION } };
    imageRef = [prepId, 0];
  }

  function imgToVideoInplace(latentRef, strength) {
    if (!imageRef) return latentRef;
    const inplaceId = id();
    nodes[inplaceId] = { class_type: 'LTXVImgToVideoInplace', inputs: { vae: vaeRef, image: imageRef, latent: latentRef, strength, bypass: false } };
    return [inplaceId, 0];
  }

  // ── Audio (optional) ───────────────────────────────────────────────────────
  let audioVaeRef = null;
  let audioLatentRef = null;
  if (enableAudio) {
    const audioVaeId    = id();
    const audioLatentId = id();
    nodes[audioVaeId]    = audioVaeName
      ? { class_type: 'VAELoader',          inputs: { vae_name: audioVaeName } }   // ComfyUI's VAE class detects the LTX audio VAE by its keys
      : { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: checkpoint } };
    nodes[audioLatentId] = { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: validFrames, frame_rate: fps, batch_size: 1, audio_vae: [audioVaeId, 0] } };
    audioVaeRef    = [audioVaeId, 0];
    audioLatentRef = [audioLatentId, 0];
  }
  function concatAV(videoRef, audioRef) {
    if (!audioRef) return videoRef;
    const concatId = id();
    nodes[concatId] = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: videoRef, audio_latent: audioRef } };
    return [concatId, 0];
  }
  // → [videoLatent, audioLatent|null]
  function separateAV(avRef) {
    if (!enableAudio) return [avRef, null];
    const sepId = id();
    nodes[sepId] = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: avRef } };
    return [[sepId, 0], [sepId, 1]];
  }

  function sample({ modelRef, latentRef, sigmasRef, samplerName, cfgValue, noiseSeed }) {
    const noiseId   = id();
    const samplerId = id();
    const guiderId  = id();
    const runId     = id();
    nodes[noiseId]   = { class_type: 'RandomNoise',    inputs: { noise_seed: noiseSeed } };
    nodes[samplerId] = { class_type: 'KSamplerSelect', inputs: { sampler_name: samplerName } };
    nodes[guiderId]  = { class_type: 'CFGGuider',      inputs: { model: modelRef, positive: posRef, negative: negRef, cfg: cfgValue } };
    nodes[runId]     = { class_type: 'SamplerCustomAdvanced', inputs: { noise: [noiseId, 0], guider: [guiderId, 0], sampler: [samplerId, 0], sigmas: sigmasRef, latent_image: latentRef } };
    return [runId, 0];
  }

  // ── Stage 1 ────────────────────────────────────────────────────────────────
  const latentId = id();
  nodes[latentId] = { class_type: 'EmptyLTXVLatentVideo', inputs: { batch_size: 1, width: s1W, height: s1H, length: validFrames } };
  const s1Video  = imgToVideoInplace([latentId, 0], twoStage ? I2V_STAGE1_STRENGTH : 1.0);
  const s1Latent = concatAV(s1Video, audioLatentRef);

  const schedId = id();
  nodes[schedId] = { class_type: 'LTXVScheduler', inputs: { steps, max_shift: recipe.maxShift, base_shift: recipe.baseShift, stretch: true, terminal: recipe.terminal, latent: s1Latent } };

  let sampled = sample({ modelRef: modelWithDistilled(recipe.loraStrength), latentRef: s1Latent, sigmasRef: [schedId, 0], samplerName: sampler, cfgValue: cfg, noiseSeed: seed });

  // ── Stage 2: spatial ×2 + refine ───────────────────────────────────────────
  if (twoStage) {
    const [s1VideoOut, s1AudioOut] = separateAV(sampled);
    const upLoaderId = id();
    const upId       = id();
    nodes[upLoaderId] = { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: upscaleModel } };
    nodes[upId]       = { class_type: 'LTXVLatentUpsampler',      inputs: { samples: s1VideoOut, upscale_model: [upLoaderId, 0], vae: vaeRef } };
    const s2Video  = imgToVideoInplace([upId, 0], 1.0);
    const s2Latent = concatAV(s2Video, s1AudioOut);
    const sigmasId = id();
    nodes[sigmasId] = { class_type: 'ManualSigmas', inputs: { sigmas: recipe.refineSigmas } };
    sampled = sample({ modelRef: modelWithDistilled(REFINE_LORA_STRENGTH), latentRef: s2Latent, sigmasRef: [sigmasId, 0], samplerName: 'lcm', cfgValue: 1, noiseSeed: seed });
  }

  // ── Decode + save ──────────────────────────────────────────────────────────
  const [videoOut, audioOut] = separateAV(sampled);
  let audioRef = null;
  if (audioOut) {
    const audioDecodeId = id();
    nodes[audioDecodeId] = { class_type: 'LTXVAudioVAEDecode', inputs: { samples: audioOut, audio_vae: audioVaeRef } };
    audioRef = [audioDecodeId, 0];
  }
  const decodeId = id();
  const createId = id();
  const saveId   = id();
  nodes[decodeId] = { class_type: 'VAEDecodeTiled', inputs: { samples: videoOut, vae: vaeRef, tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 4 } };
  nodes[createId] = { class_type: 'CreateVideo',    inputs: { images: [decodeId, 0], fps, ...(audioRef ? { audio: audioRef } : {}) } };
  nodes[saveId]   = { class_type: 'SaveVideo',      inputs: { video: [createId, 0], filename_prefix: 'iterator_video', format: 'auto', codec: 'auto' } };

  return nodes;
}

module.exports = { build, defaults, RECIPES };

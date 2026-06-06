'use strict';

// WanVideo workflow — native ComfyUI nodes only (no kijai/ComfyUI-WanVideoWrapper).
//
// 14B MoE: pass both unetName (high-noise expert) and unetName2 (low-noise expert).
//   Uses two KSamplerAdvanced nodes: high-noise covers the first half of steps,
//   low-noise covers the second half.
//
// 5B TI2V: pass only unetName. Single KSampler.
//   Wan22ImageToVideoLatent handles both T2V (no start_image) and I2V (start_image set).
//
// ModelSamplingSD3 is used on both models to apply the flow-matching shift.

const SHIFT = 8.0;

const defaults = {
  width:     832,
  height:    480,
  frames:    81,
  fps:       16,
  steps:     20,
  guidance:  5.0,
  sampler:   'euler',
  scheduler: 'simple',
};

function build(params) {
  const {
    unetName, unetName2, vaeName, clipName,
    modelQuantization = 'default',
    positivePrompt = '',
    width     = defaults.width,
    height    = defaults.height,
    frames    = defaults.frames,
    fps       = defaults.fps,
    steps     = defaults.steps,
    guidance  = defaults.guidance,
    sampler   = defaults.sampler,
    scheduler = defaults.scheduler,
    seed      = Math.floor(Math.random() * 2 ** 32),
    inputRef  = null,
    isI2V     = true,
  } = params;

  const imgPath = inputRef
    ? (inputRef.subfolder ? `${inputRef.subfolder}/${inputRef.filename}` : inputRef.filename)
    : null;

  const isMoE     = !!unetName2;
  const splitStep = isMoE ? Math.ceil(steps / 2) : steps;

  // Map legacy 'disabled' option name to the native UNETLoader value
  const weightDtype = modelQuantization === 'disabled' ? 'default' : (modelQuantization || 'default');

  const nodes = {};
  let n = 1;
  const id = () => String(n++);

  // ── Model loader(s) ──────────────────────────────────────────────────────────
  const highModelId = id();
  nodes[highModelId] = {
    class_type: 'UNETLoader',
    inputs: { unet_name: unetName, weight_dtype: weightDtype },
  };

  let lowModelId = null;
  if (isMoE) {
    lowModelId = id();
    nodes[lowModelId] = {
      class_type: 'UNETLoader',
      inputs: { unet_name: unetName2, weight_dtype: 'default' },
    };
  }

  // ── VAE + CLIP ────────────────────────────────────────────────────────────────
  const vaeId = id();
  nodes[vaeId] = { class_type: 'VAELoader', inputs: { vae_name: vaeName } };

  const clipLoaderId = id();
  nodes[clipLoaderId] = { class_type: 'CLIPLoader', inputs: { clip_name: clipName, type: 'wan' } };

  // ── Text conditioning ─────────────────────────────────────────────────────────
  const posEncId = id();
  nodes[posEncId] = { class_type: 'CLIPTextEncode', inputs: { clip: [clipLoaderId, 0], text: positivePrompt } };

  const negEncId = id();
  nodes[negEncId] = { class_type: 'CLIPTextEncode', inputs: { clip: [clipLoaderId, 0], text: '' } };

  // ── Flow-matching shift (ModelSamplingSD3) ────────────────────────────────────
  const sampledHighId = id();
  nodes[sampledHighId] = { class_type: 'ModelSamplingSD3', inputs: { model: [highModelId, 0], shift: SHIFT } };

  let sampledLowId = null;
  if (isMoE) {
    sampledLowId = id();
    nodes[sampledLowId] = { class_type: 'ModelSamplingSD3', inputs: { model: [lowModelId, 0], shift: SHIFT } };
  }

  // ── Latent + I2V conditioning ─────────────────────────────────────────────────
  // WanImageToVideo creates the 36-channel combined latent (16 noise + 16 image + 4 mask)
  // expected by Wan 2.1/2.2 14B I2V model weights — BUT ONLY when given wan_2.1_vae.
  //
  // IMPORTANT: using wan2.2_vae here causes WanImageToVideo to create a 64-channel latent
  // (the TI2V format), which is incompatible with the 14B I2V models. Always use
  // wan_2.1_vae.safetensors with the 14B I2V models, NOT wan2.2_vae.safetensors.
  // wan2.2_vae is only correct for the 5B TI2V single-UNet model.
  //
  // Wan22ImageToVideoLatent also creates 64 channels and must NOT be used for I2V 14B.
  let posRef    = [posEncId, 0];
  let negRef    = [negEncId, 0];
  let latentRef;

  if (isI2V && imgPath) {
    const loadImgId = id();
    nodes[loadImgId] = { class_type: 'LoadImage', inputs: { image: imgPath } };

    const i2vId = id();
    nodes[i2vId] = {
      class_type: 'WanImageToVideo',
      inputs: {
        positive:    [posEncId, 0],
        negative:    [negEncId, 0],
        vae:         [vaeId, 0],
        start_image: [loadImgId, 0],
        width, height, length: frames, batch_size: 1,
      },
    };
    posRef    = [i2vId, 0];
    negRef    = [i2vId, 1];
    latentRef = [i2vId, 2];
  } else {
    // T2V — standard empty latent; only valid with T2V model files (16-channel patchify)
    const emptyId = id();
    nodes[emptyId] = {
      class_type: 'EmptyHunyuanLatentVideo',
      inputs: { width, height, video_length: frames, batch_size: 1 },
    };
    latentRef = [emptyId, 0];
  }

  // ── Sampler(s) ────────────────────────────────────────────────────────────────
  let finalSamplesRef;

  if (isMoE) {
    const highSamplerId = id();
    nodes[highSamplerId] = {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: [sampledHighId, 0], positive: posRef, negative: negRef,
        latent_image: latentRef,
        add_noise: 'enable', noise_seed: seed, steps, cfg: guidance,
        sampler_name: sampler, scheduler,
        start_at_step: 0, end_at_step: splitStep,
        return_with_leftover_noise: 'enable',
      },
    };

    const lowSamplerId = id();
    nodes[lowSamplerId] = {
      class_type: 'KSamplerAdvanced',
      inputs: {
        model: [sampledLowId, 0], positive: posRef, negative: negRef,
        latent_image: [highSamplerId, 0],
        add_noise: 'disable', noise_seed: seed, steps, cfg: guidance,
        sampler_name: sampler, scheduler,
        start_at_step: splitStep, end_at_step: 10000,
        return_with_leftover_noise: 'disable',
      },
    };
    finalSamplesRef = [lowSamplerId, 0];
  } else {
    const samplerId = id();
    nodes[samplerId] = {
      class_type: 'KSampler',
      inputs: {
        model: [sampledHighId, 0], positive: posRef, negative: negRef,
        latent_image: latentRef,
        seed, steps, cfg: guidance, sampler_name: sampler, scheduler, denoise: 1.0,
      },
    };
    finalSamplesRef = [samplerId, 0];
  }

  // ── Decode + output ───────────────────────────────────────────────────────────
  const decodeId = id();
  nodes[decodeId] = { class_type: 'VAEDecode', inputs: { vae: [vaeId, 0], samples: finalSamplesRef } };

  const createVideoId = id();
  nodes[createVideoId] = { class_type: 'CreateVideo', inputs: { images: [decodeId, 0], fps } };

  const saveVideoId = id();
  nodes[saveVideoId] = {
    class_type: 'SaveVideo',
    inputs: { video: [createVideoId, 0], filename_prefix: 'iterator_video', format: 'auto', codec: 'auto' },
  };

  return nodes;
}

module.exports = { build, defaults };

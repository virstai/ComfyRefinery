'use strict';

const defaults = {
  width:     768,
  height:    512,
  frames:    97,
  fps:       24,
  steps:     25,
  guidance:  3.5,
  sampler:   'euler',
};

function build(params) {
  const {
    checkpoint, clipName, distilledLoraName, enableAudio = false,
    positivePrompt = '',
    width     = defaults.width,
    height    = defaults.height,
    frames    = defaults.frames,
    fps       = defaults.fps,
    steps     = defaults.steps,
    guidance  = defaults.guidance,
    sampler   = defaults.sampler,
    seed      = Math.floor(Math.random() * 2 ** 32),
    inputRef  = null,
    isI2V     = false,
  } = params;

  // LTX latent temporal factor is 8, so valid frame counts are 1 + N×8 (1, 9, 17 … 97, 105, 113, 121…)
  // Snap the requested frame count to the nearest valid value so ComfyUI doesn't fall back to its default.
  const validFrames = Math.max(1, Math.round((frames - 1) / 8) * 8 + 1);

  const imgPath = inputRef
    ? (inputRef.subfolder ? `${inputRef.subfolder}/${inputRef.filename}` : inputRef.filename)
    : null;

  let n = 0;
  const id = () => String(++n);

  // Model + text encoder
  // LTXAVTextEncoderLoader loads both Gemma 3 12B (text_encoder) and extracts T5 from the
  // checkpoint — correct for LTX-2.3 22B which is the AV model and needs both encoders.
  // CLIPLoader type:"ltxv" only loads T5-XXL and produces wrong-shaped tensors for Gemma files.
  const ckptId = id(); // 1
  const clipId = id(); // 2
  const nodes = {
    [ckptId]: { class_type: 'CheckpointLoaderSimple',   inputs: { ckpt_name: checkpoint } },
    [clipId]: { class_type: 'LTXAVTextEncoderLoader',   inputs: { text_encoder: clipName, ckpt_name: checkpoint, device: 'default' } },
  };

  // Distilled guidance LoRA (optional)
  let modelRef = [ckptId, 0];
  if (distilledLoraName) {
    const loraId = id();
    nodes[loraId] = {
      class_type: 'LTX2LoraLoaderAdvanced',
      inputs: { lora_name: distilledLoraName, model: modelRef, strength_model: 1.0, video: 1.0, video_to_audio: 1.0, audio: 1.0, audio_to_video: 1.0, other: 1.0 },
    };
    modelRef = [loraId, 0];
  }

  // Patch model with LTXV sigma schedule
  const samplingId = id();
  nodes[samplingId] = { class_type: 'ModelSamplingLTXV', inputs: { model: modelRef, max_shift: 2.05, base_shift: 0.95 } };
  const modelPatched = [samplingId, 0];
  const vaeRef       = [ckptId, 2];

  // Text conditioning
  const posId = id();
  const negId = id();
  nodes[posId] = { class_type: 'CLIPTextEncode', inputs: { clip: [clipId, 0], text: positivePrompt } };
  nodes[negId] = { class_type: 'CLIPTextEncode', inputs: { clip: [clipId, 0], text: '' } };

  // LTXV frame-rate conditioning
  const condId = id();
  nodes[condId] = { class_type: 'LTXVConditioning', inputs: { positive: [posId, 0], negative: [negId, 0], frame_rate: fps } };

  // Empty latent
  const latentId = id();
  nodes[latentId] = { class_type: 'EmptyLTXVLatentVideo', inputs: { batch_size: 1, width, height, length: validFrames } };

  let posRef    = [condId, 0];
  let negRef    = [condId, 1];
  let latentRef = [latentId, 0];

  // I2V: inject first-frame guide
  if (isI2V && imgPath) {
    const imgId   = id();
    const guideId = id();
    nodes[imgId]   = { class_type: 'LoadImage',     inputs: { image: imgPath } };
    nodes[guideId] = { class_type: 'LTXVAddGuide',  inputs: { positive: posRef, negative: negRef, vae: vaeRef, latent: latentRef, image: [imgId, 0], frame_idx: 0, strength: 1.0 } };
    posRef    = [guideId, 0];
    negRef    = [guideId, 1];
    latentRef = [guideId, 2];
  }

  // Optional audio: load audio VAE from same checkpoint, build empty audio latent,
  // concatenate with video latent before sampling, separate after.
  let audioVaeRef = null;
  if (enableAudio) {
    const audioVaeId     = id();
    const audioLatentId  = id();
    const concatId       = id();
    nodes[audioVaeId]    = { class_type: 'LTXVAudioVAELoader',   inputs: { ckpt_name: checkpoint } };
    nodes[audioLatentId] = { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: validFrames, frame_rate: fps, batch_size: 1, audio_vae: [audioVaeId, 0] } };
    nodes[concatId]      = { class_type: 'LTXVConcatAVLatent',   inputs: { video_latent: latentRef, audio_latent: [audioLatentId, 0] } };
    audioVaeRef = [audioVaeId, 0];
    latentRef   = [concatId, 0];
  }

  // KSampler (simpler than SamplerCustomAdvanced + MultimodalGuider, no extra nodes needed)
  const sampleId = id();
  nodes[sampleId] = {
    class_type: 'KSampler',
    inputs: { model: modelPatched, positive: posRef, negative: negRef, latent_image: latentRef, sampler_name: sampler, scheduler: 'simple', steps, cfg: guidance, denoise: 1.0, seed },
  };

  // Separate AV latent back into video + audio streams after sampling,
  // then pass decoded audio into CreateVideo so the output MP4 has audio embedded.
  let videoSampledRef = [sampleId, 0];
  let audioRef        = null;
  if (enableAudio) {
    const separateId      = id();
    const audioDecodeId   = id();
    nodes[separateId]    = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: [sampleId, 0] } };
    nodes[audioDecodeId] = { class_type: 'LTXVAudioVAEDecode',   inputs: { samples: [separateId, 1], audio_vae: audioVaeRef } };
    videoSampledRef = [separateId, 0];
    audioRef        = [audioDecodeId, 0];
  }

  // Decode + save — audio wired into CreateVideo when enabled, producing a single MP4 with audio
  const decodeId = id();
  const createId = id();
  const saveId   = id();
  nodes[decodeId] = { class_type: 'VAEDecode',   inputs: { vae: vaeRef, samples: videoSampledRef } };
  nodes[createId] = { class_type: 'CreateVideo', inputs: { images: [decodeId, 0], fps, ...(audioRef ? { audio: audioRef } : {}) } };
  nodes[saveId]   = { class_type: 'SaveVideo',   inputs: { video: [createId, 0], filename_prefix: 'iterator_video', format: 'auto', codec: 'auto' } };

  return nodes;
}

module.exports = { build, defaults };

'use strict';

// MiniMax H3 (Hailuo 3) — open-weights 33B omni-modal video model with native
// stereo audio. Uses only native ComfyUI nodes (ComfyUI ≥ 0.30.0).
//
// Three modes, two checkpoints:
//   T2V / I2V — FL2VA checkpoint via MiniMaxH3ImageToVideo (optional first_frame
//               and last_frame — the latter pins the shot's final frame)
//   R2V       — Ref2VA checkpoint via MiniMaxH3ReferenceToVideo: reference images
//               (<Picture i>, ≤9), reference video clips with their soundtrack
//               (<Video k>, ≤3, 2–15 s) and standalone reference audio such as a
//               voice sample (<Audio j>, ≤3). The audio VAE is a required input
//               of that node, so R2V refuses to build without one.
//
// The prompt is encoded inside the MiniMax node itself (no CLIPTextEncode), and
// the model is guidance-free: BasicGuider only, no negative prompt, no CFG.
// One sampled latent carries both modalities — VAEDecode extracts the frames,
// VAEDecodeAudio the audio (decoded only when an audio VAE is configured).

// Autogrow input limits of MiniMaxH3ReferenceToVideo (ComfyUI 0.34).
const MAX_REF_IMAGES = 9;
const MAX_REF_VIDEOS = 3;
const MAX_REF_AUDIOS = 3;

const { applyModelOnlyLoraChain } = require('./lib/loraChain');

const defaults = {
  width:   1344,
  height:  768,
  frames:  73,
  fps:     24,
  steps:   20,
  sampler: 'res_multistep',
};

function build(params) {
  const {
    unetName, refUnetName, clipName, vaeName, audioVaeName,
    distilledLoraName, refDistilledLoraName,
    positivePrompt = '',
    width     = defaults.width,
    height    = defaults.height,
    frames    = defaults.frames,
    fps       = defaults.fps,
    steps:    stepsIn = null,
    sampler   = defaults.sampler,
    seed      = Math.floor(Math.random() * 2 ** 32),
    inputRef  = null,
    isI2V     = false,
    lastFrameRef = null,
    referenceRefs = [],
    referenceVideos = [],
    referenceAudios = [],
    isR2V     = false,
    refImageSize = 'match',
    loras     = [],
  } = params;

  const useR2V = isR2V && (referenceRefs.length + referenceVideos.length + referenceAudios.length) > 0;
  if (useR2V && !refUnetName) {
    throw new Error('MiniMax H3: reference-to-video requested but no Ref2VA model file is set (refUnetName)');
  }
  if (useR2V && !audioVaeName) {
    throw new Error('MiniMax H3: reference-to-video needs the Audio VAE file (audioVaeName) — audio_vae is a required input of MiniMaxH3ReferenceToVideo');
  }
  if (referenceRefs.length > MAX_REF_IMAGES)   throw new Error(`MiniMax H3: at most ${MAX_REF_IMAGES} reference images (got ${referenceRefs.length})`);
  if (referenceVideos.length > MAX_REF_VIDEOS) throw new Error(`MiniMax H3: at most ${MAX_REF_VIDEOS} reference videos (got ${referenceVideos.length})`);
  if (referenceAudios.length > MAX_REF_AUDIOS) throw new Error(`MiniMax H3: at most ${MAX_REF_AUDIOS} reference audio clips (got ${referenceAudios.length})`);

  // H3's temporal grid: valid frame counts are 17k+5 (5, 22, 39 … 73 … 124).
  // Snap up so the requested duration is never shortened.
  const f = Math.max(5, Math.round(frames));
  const validFrames = f + ((5 - (f % 17)) % 17 + 17) % 17;

  const refPath = ref => (ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename);

  let n = 0;
  const id = () => String(++n);

  // Loaders — the Ref2VA checkpoint (and its own turbo LoRA) drive R2V
  const unetId = id();
  const clipId = id();
  const vaeId  = id();
  const nodes = {
    [unetId]: { class_type: 'UNETLoader', inputs: { unet_name: useR2V ? refUnetName : unetName, weight_dtype: 'default' } },
    [clipId]: { class_type: 'CLIPLoader', inputs: { clip_name: clipName, type: 'minimax', device: 'default' } },
    [vaeId]:  { class_type: 'VAELoader',  inputs: { vae_name: vaeName } },
  };

  let audioVaeRef = null;
  if (audioVaeName) {
    const audioVaeId = id();
    nodes[audioVaeId] = { class_type: 'VAELoader', inputs: { vae_name: audioVaeName } };
    audioVaeRef = [audioVaeId, 0];
  }

  // Optional turbo LoRA (DiT only) — 8-step for FL2VA, 4-step for Ref2VA
  let modelRef = [unetId, 0];
  const loraName = useR2V ? refDistilledLoraName : distilledLoraName;
  if (loraName) {
    const loraId = id();
    nodes[loraId] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: loraName, model: modelRef, strength_model: 1.0 } };
    modelRef = [loraId, 0];
  }

  // Extra LoRAs (scene / style / motion) chain after the turbo LoRA. H3 LoRAs
  // are DiT-only, so LoraLoaderModelOnly — there is no CLIP to patch.
  modelRef = applyModelOnlyLoraChain(nodes, modelRef, loras.filter(l => l?.name), () => id());

  // Turbo LoRAs are distilled for a fixed low step count — running them at the
  // full 20 steps over-walks the schedule and produces grainy output. When the
  // step doesn't pin a count, follow the active LoRA's trained count.
  const steps = stepsIn ?? (loraName ? (useR2V ? 4 : 8) : defaults.steps);

  // Conditioning + latent — the MiniMax node encodes the prompt and emits
  // [0] positive conditioning, [1] the AV latent
  let h3Id;
  if (useR2V) {
    h3Id = id();
    const refInputs = {};
    referenceRefs.forEach((ref, i) => {
      const imgId = id();
      nodes[imgId] = { class_type: 'LoadImage', inputs: { image: refPath(ref) } };
      refInputs[`ref_images.ref_image_${i}`] = [imgId, 0];
    });
    // Reference clips: LoadVideo → GetVideoComponents yields [0] frames, [1] audio.
    // The soundtrack rides along as the same-numbered ref_video_audio unless the
    // caller marks the clip silent (`audio: false`) — a silent file has no track
    // to extract.
    referenceVideos.forEach((ref, k) => {
      const vidId = id();
      const gvcId = id();
      nodes[vidId] = { class_type: 'LoadVideo',          inputs: { file: refPath(ref) } };
      nodes[gvcId] = { class_type: 'GetVideoComponents', inputs: { video: [vidId, 0] } };
      refInputs[`ref_videos.ref_video_${k}`] = [gvcId, 0];
      if (ref.audio !== false) refInputs[`ref_video_audios.ref_video_audio_${k}`] = [gvcId, 1];
    });
    referenceAudios.forEach((ref, j) => {
      const audId = id();
      nodes[audId] = { class_type: 'LoadAudio', inputs: { audio: refPath(ref) } };
      refInputs[`ref_audios.ref_audio_${j}`] = [audId, 0];
    });
    nodes[h3Id] = {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        clip: [clipId, 0], vae: [vaeId, 0],
        audio_vae: audioVaeRef,
        ...refInputs,
        prompt: positivePrompt, width, height, length: validFrames, ref_image_size: refImageSize,
      },
    };
  } else {
    // Frame images are pre-scaled to H3's native pixel budget (~0.9 MP, /32 grid)
    const loadFrame = ref => {
      const imgId   = id();
      const scaleId = id();
      nodes[imgId]   = { class_type: 'LoadImage',              inputs: { image: refPath(ref) } };
      nodes[scaleId] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [imgId, 0], upscale_method: 'nearest-exact', megapixels: 0.9, resolution_steps: 32 } };
      return [scaleId, 0];
    };
    const firstFrameRef = (isI2V && inputRef) ? loadFrame(inputRef) : null;
    const lastFrameOut  = lastFrameRef ? loadFrame(lastFrameRef) : null;
    h3Id = id();
    nodes[h3Id] = {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: [clipId, 0], vae: [vaeId, 0],
        ...(firstFrameRef ? { first_frame: firstFrameRef } : {}),
        ...(lastFrameOut  ? { last_frame:  lastFrameOut }  : {}),
        prompt: positivePrompt, width, height, length: validFrames,
      },
    };
  }

  // Sampling — guidance-free custom sampler chain
  const noiseId     = id();
  const samplerId   = id();
  const schedulerId = id();
  const guiderId    = id();
  const sampleId    = id();
  nodes[noiseId]     = { class_type: 'RandomNoise',           inputs: { noise_seed: seed } };
  nodes[samplerId]   = { class_type: 'KSamplerSelect',        inputs: { sampler_name: sampler } };
  nodes[schedulerId] = { class_type: 'BasicScheduler',        inputs: { model: modelRef, scheduler: 'simple', steps, denoise: 1.0 } };
  nodes[guiderId]    = { class_type: 'BasicGuider',           inputs: { model: modelRef, conditioning: [h3Id, 0] } };
  nodes[sampleId]    = { class_type: 'SamplerCustomAdvanced', inputs: { noise: [noiseId, 0], guider: [guiderId, 0], sampler: [samplerId, 0], sigmas: [schedulerId, 0], latent_image: [h3Id, 1] } };

  // Decode — same latent feeds both video and audio decoders
  let audioRef = null;
  if (audioVaeRef) {
    const audioDecodeId = id();
    nodes[audioDecodeId] = { class_type: 'VAEDecodeAudio', inputs: { samples: [sampleId, 0], vae: audioVaeRef } };
    audioRef = [audioDecodeId, 0];
  }

  const decodeId = id();
  const createId = id();
  const saveId   = id();
  nodes[decodeId] = { class_type: 'VAEDecode',   inputs: { samples: [sampleId, 0], vae: [vaeId, 0] } };
  nodes[createId] = { class_type: 'CreateVideo', inputs: { images: [decodeId, 0], fps, ...(audioRef ? { audio: audioRef } : {}) } };
  nodes[saveId]   = { class_type: 'SaveVideo',   inputs: { video: [createId, 0], filename_prefix: 'iterator_video', format: 'auto', codec: 'auto' } };

  // Silent fallback: the audio VAE has produced NaN samples on long takes,
  // which makes the AAC encoder inside SaveVideo throw and lose the whole
  // (very expensive) video. This copy depends only on the frame decoder, so
  // ComfyUI's scheduler writes it before the audio path runs; if the muxed
  // save then fails, the pipeline keeps this file and warns. `_noaudio` in
  // the prefix is how the video step tells the two apart.
  if (audioRef) {
    const createSilentId = id();
    const saveSilentId   = id();
    nodes[createSilentId] = { class_type: 'CreateVideo', inputs: { images: [decodeId, 0], fps } };
    nodes[saveSilentId]   = { class_type: 'SaveVideo',   inputs: { video: [createSilentId, 0], filename_prefix: 'iterator_video_noaudio', format: 'auto', codec: 'auto' } };
  }

  return nodes;
}

module.exports = { build, defaults, MAX_REF_IMAGES, MAX_REF_VIDEOS, MAX_REF_AUDIOS };

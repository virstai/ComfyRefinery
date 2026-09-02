'use strict';

// MiniMax H3 (Hailuo 3) — open-weights 33B omni-modal video model with native
// stereo audio. Uses only native ComfyUI nodes (ComfyUI ≥ 0.30.0).
//
// Three modes, two checkpoints:
//   T2V / I2V — FL2VA checkpoint via MiniMaxH3ImageToVideo (optional first_frame)
//   R2V       — Ref2VA checkpoint via MiniMaxH3ReferenceToVideo (reference images
//               cited in the prompt as <Picture 1>…<Picture N>)
//
// The prompt is encoded inside the MiniMax node itself (no CLIPTextEncode), and
// the model is guidance-free: BasicGuider only, no negative prompt, no CFG.
// One sampled latent carries both modalities — VAEDecode extracts the frames,
// VAEDecodeAudio the audio (decoded only when an audio VAE is configured).

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
    steps     = defaults.steps,
    sampler   = defaults.sampler,
    seed      = Math.floor(Math.random() * 2 ** 32),
    inputRef  = null,
    isI2V     = false,
    referenceRefs = [],
    isR2V     = false,
    refImageSize = 'match',
  } = params;

  const useR2V = isR2V && referenceRefs.length > 0;
  if (useR2V && !refUnetName) {
    throw new Error('MiniMax H3: reference-to-video requested but no Ref2VA model file is set (refUnetName)');
  }

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
    nodes[h3Id] = {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        clip: [clipId, 0], vae: [vaeId, 0],
        ...(audioVaeRef ? { audio_vae: audioVaeRef } : {}),
        ...refInputs,
        prompt: positivePrompt, width, height, length: validFrames, ref_image_size: refImageSize,
      },
    };
  } else {
    // First frame is pre-scaled to H3's native pixel budget (~0.9 MP, /32 grid)
    let firstFrameRef = null;
    if (isI2V && inputRef) {
      const imgId   = id();
      const scaleId = id();
      nodes[imgId]   = { class_type: 'LoadImage',              inputs: { image: refPath(inputRef) } };
      nodes[scaleId] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [imgId, 0], upscale_method: 'nearest-exact', megapixels: 0.9, resolution_steps: 32 } };
      firstFrameRef = [scaleId, 0];
    }
    h3Id = id();
    nodes[h3Id] = {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: [clipId, 0], vae: [vaeId, 0],
        ...(firstFrameRef ? { first_frame: firstFrameRef } : {}),
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

  return nodes;
}

module.exports = { build, defaults };

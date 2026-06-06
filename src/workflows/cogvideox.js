'use strict';

const defaults = {
  width:     720,
  height:    480,
  frames:    49,
  fps:       8,
  steps:     50,
  cfgScale:  6.0,
  sampler:   'euler',
  scheduler: 'simple',
};

function build(params) {
  const {
    checkpoint, vae, clipName,
    positivePrompt = '',
    width     = defaults.width,
    height    = defaults.height,
    frames    = defaults.frames,
    fps       = defaults.fps,
    steps     = defaults.steps,
    cfgScale  = defaults.cfgScale,
    sampler   = defaults.sampler,
    scheduler = defaults.scheduler,
    seed      = Math.floor(Math.random() * 2 ** 32),
    inputRef  = null,
    isI2V     = false,
  } = params;

  const imgPath = inputRef
    ? (inputRef.subfolder ? `${inputRef.subfolder}/${inputRef.filename}` : inputRef.filename)
    : null;

  const nodes = {
    "1": {
      class_type: "CogVideoXModelLoader",
      inputs: { ckpt_name: checkpoint },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: clipName, type: "cogvideox" },
    },
    "3": {
      class_type: "CogVideoXTextEncode",
      inputs: { clip: ["2", 0], positive_text: positivePrompt, negative_text: "" },
    },
    "4": {
      class_type: "CogVideoXEmptyLatentVideo",
      inputs: { batch_size: 1, width, height, num_frames: frames },
    },
  };

  if (isI2V && imgPath) {
    nodes["5"] = {
      class_type: "LoadImage",
      inputs: { image: imgPath },
    };
    nodes["6"] = {
      class_type: "CogVideoXImageEncode",
      inputs: { vae: ["1", 1], image: ["5", 0] },
    };
    nodes["7"] = {
      class_type: "CogVideoXSampler",
      inputs: { model: ["1", 0], positive: ["3", 0], negative: ["3", 1], samples: ["4", 0], image_cond_latents: ["6", 0], seed, steps, cfg: cfgScale, denoise_strength: 1.0, sampler_name: sampler, scheduler },
    };
    nodes["8"] = {
      class_type: "VAEDecode",
      inputs: { vae: ["1", 1], samples: ["7", 0] },
    };
    nodes["9"] = {
      class_type: "CreateVideo",
      inputs: { images: ["8", 0], fps },
    };
    nodes["10"] = {
      class_type: "SaveVideo",
      inputs: { video: ["9", 0], filename_prefix: "iterator_video", format: "auto", codec: "auto" },
    };
  } else {
    nodes["5"] = {
      class_type: "CogVideoXSampler",
      inputs: { model: ["1", 0], positive: ["3", 0], negative: ["3", 1], samples: ["4", 0], seed, steps, cfg: cfgScale, denoise_strength: 1.0, sampler_name: sampler, scheduler },
    };
    nodes["6"] = {
      class_type: "VAEDecode",
      inputs: { vae: ["1", 1], samples: ["5", 0] },
    };
    nodes["7"] = {
      class_type: "CreateVideo",
      inputs: { images: ["6", 0], fps },
    };
    nodes["8"] = {
      class_type: "SaveVideo",
      inputs: { video: ["7", 0], filename_prefix: "iterator_video", format: "auto", codec: "auto" },
    };
  }

  return nodes;
}

module.exports = { build, defaults };

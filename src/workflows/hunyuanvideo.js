'use strict';

const defaults = {
  width:     848,
  height:    480,
  frames:    45,
  fps:       24,
  steps:     30,
  guidance:  6.0,
  sampler:   'euler',
  scheduler: 'simple',
};

function build(params) {
  const {
    unetName, vaeName, clipName,
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
    isI2V     = false,
  } = params;

  const imgPath = inputRef
    ? (inputRef.subfolder ? `${inputRef.subfolder}/${inputRef.filename}` : inputRef.filename)
    : null;

  const nodes = {
    "1": {
      class_type: "HunyuanVideoModelLoader",
      inputs: { model_name: unetName, vae: vaeName, precision: "bf16", fp8_unet: false },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: clipName, type: "llama" },
    },
    "3": {
      class_type: "HunyuanVideoTextEncode",
      inputs: { clip: ["2", 0], positive_text: positivePrompt, negative_text: "" },
    },
    "4": {
      class_type: "EmptyHunyuanLatentVideo",
      inputs: { batch_size: 1, width, height, video_length: frames },
    },
  };

  if (isI2V && imgPath) {
    nodes["5"] = {
      class_type: "LoadImage",
      inputs: { image: imgPath },
    };
    nodes["6"] = {
      class_type: "HunyuanVideoImageToVideo",
      inputs: { model: ["1", 0], image: ["5", 0], width, height, video_length: frames },
    };
    nodes["7"] = {
      class_type: "KSampler",
      inputs: {
        model: ["6", 0], positive: ["3", 0], negative: ["3", 1],
        latent_image: ["4", 0], seed, steps, cfg: guidance,
        sampler_name: sampler, scheduler, denoise: 1.0,
      },
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
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["3", 0], negative: ["3", 1],
        latent_image: ["4", 0], seed, steps, cfg: guidance,
        sampler_name: sampler, scheduler, denoise: 1.0,
      },
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

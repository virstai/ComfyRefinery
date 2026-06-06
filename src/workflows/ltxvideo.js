'use strict';

const defaults = {
  width:     768,
  height:    512,
  frames:    97,
  fps:       24,
  steps:     25,
  guidance:  3.5,
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
      class_type: "LTXVLoader",
      inputs: { ckpt_name: unetName, vae_name: vaeName },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: clipName, type: "ltxv" },
    },
    "3": {
      class_type: "LTXVTextEncode",
      inputs: { clip: ["2", 0], positive: positivePrompt, negative: "" },
    },
    "4": {
      class_type: "EmptyLTXVLatentVideo",
      inputs: { batch_size: 1, width, height, length: frames },
    },
  };

  if (isI2V && imgPath) {
    nodes["5"] = {
      class_type: "LoadImage",
      inputs: { image: imgPath },
    };
    nodes["6"] = {
      class_type: "LTXVConditioning",
      inputs: { positive: ["3", 0], negative: ["3", 1], vae: ["1", 1], image: ["5", 0], width, height, length: frames },
    };
    nodes["7"] = {
      class_type: "LTXVSampler",
      inputs: { model: ["1", 0], positive: ["6", 0], negative: ["6", 1], latent: ["4", 0], seed, steps, cfg: guidance, sampler_name: sampler, scheduler, denoise: 1.0 },
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
      class_type: "LTXVSampler",
      inputs: { model: ["1", 0], positive: ["3", 0], negative: ["3", 1], latent: ["4", 0], seed, steps, cfg: guidance, sampler_name: sampler, scheduler, denoise: 1.0 },
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

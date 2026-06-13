'use strict';

// Map safetensors training metadata to a ComfyRefinery architecture id.
// ss_base_model_version is written by kohya sd-scripts; modelspec.architecture
// by the stability modelspec standard. Unknown → null (hidden from the LLM
// until the user assigns an architecture in the LoRAs panel).

const SS_PATTERNS = [
  [/^sd_v1/i, 'sd15'],
  [/^sd_v2/i, 'sd15'],   // SD2 runs on the sd15 builder
  [/^sdxl/i,  'sdxl'],
  [/^sd3/i,   'sd3'],
  [/^flux2/i, 'flux2'],
  [/^flux/i,  'flux'],
  [/anima/i,  'anima'],
  [/chroma/i, 'chroma'],
];

const MODELSPEC_PATTERNS = [
  [/stable-diffusion-xl/i, 'sdxl'],
  [/stable-diffusion-v1|sd-v1/i, 'sd15'],
  [/stable-diffusion-3/i,  'sd3'],
  [/flux-?2/i,             'flux2'],
  [/flux/i,                'flux'],
  [/anima/i,               'anima'],
  [/chroma/i,              'chroma'],
];

function matchPatterns(patterns, value) {
  if (typeof value !== 'string') return null;
  for (const [re, arch] of patterns) {
    if (re.test(value)) return arch;
  }
  return null;
}

function detectArchitecture(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  return matchPatterns(SS_PATTERNS, metadata.ss_base_model_version)
      ?? matchPatterns(MODELSPEC_PATTERNS, metadata['modelspec.architecture']);
}

module.exports = { detectArchitecture };

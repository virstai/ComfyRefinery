'use strict';

// Map preprocessor type → ComfyUI node for comfyui_controlnet_aux.
// All preprocessors auto-download their model weights on first use.
//
// Rankings for photo-to-anime style transfer (Klein → SDXL Illustrious):
//   depth      — best: encodes 3D spatial layout only, zero texture/color leakage
//   softedge   — good: loose edge contours, versatile, handles diverse sources
//   lineart_realistic — precise lines from photographic/realistic sources
//   lineart_anime     — smoother anime-style contours from already-stylized sources
//   canny      — avoid for style transfer: too rigid, over-constrains anatomy
function buildPreprocessorNode(type, imageRef, resolution) {
  switch (type) {
    case 'depth':
      // MiDaS: reliable depth on diverse image types; no separate model download
      return { class_type: 'MiDaS-DepthMapPreprocessor', inputs: { image: imageRef, a: Math.PI * 2, bg_threshold: 0.1, resolution } };
    case 'softedge':
      return { class_type: 'HEDPreprocessor', inputs: { image: imageRef, safe: 'enable', resolution } };
    case 'lineart_realistic':
      return { class_type: 'LineartRealisticPreprocessor', inputs: { image: imageRef, resolution } };
    case 'lineart_anime':
      return { class_type: 'AnimeLineArtPreprocessor', inputs: { image: imageRef, resolution } };
    case 'canny':
      return { class_type: 'CannyEdgePreprocessor', inputs: { image: imageRef, low_threshold: 100, high_threshold: 200, resolution } };
    default:
      return { class_type: 'MiDaS-DepthMapPreprocessor', inputs: { image: imageRef, a: Math.PI * 2, bg_threshold: 0.1, resolution } };
  }
}

module.exports = { buildPreprocessorNode };

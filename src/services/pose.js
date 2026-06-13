'use strict';

// Pose pre-pass: generate a quick draft with a dedicated pose model, extract an
// OpenPose skeleton via DWPose (comfyui_controlnet_aux), and re-upload it as a
// ComfyUI input for use as the ControlNet conditioning image.
// One ComfyUI run: the draft graph's SaveImage is rewired through DWPose, so
// the run's output IS the skeleton.

const comfyui = require('./comfyui');
const png     = require('../lib/png');
const { buildWorkflow: buildArchWorkflow } = require('../workflows');

// comfyui_controlnet_aux defaults, verified against the pack's dwpose.py.
// Both detector models auto-download from huggingface on first use.
const DWPOSE_NODE    = 'DWPreprocessor';
const BBOX_DETECTOR  = 'yolox_l.onnx';
const POSE_ESTIMATOR = 'dw-ll_ucoco_384.onnx';

function buildPoseGraph(poseModelConfig, prompt, { width, height }) {
  const { workflow } = buildArchWorkflow(poseModelConfig, { positivePrompt: prompt, width, height });

  const saveEntry = Object.entries(workflow).find(([, n]) => n.class_type === 'SaveImage');
  if (!saveEntry) throw new Error('Pose model graph has no SaveImage node');
  const [saveId, saveNode] = saveEntry;

  workflow['990'] = {
    class_type: DWPOSE_NODE,
    inputs: {
      image:          saveNode.inputs.images,
      detect_hand:    'enable',
      detect_body:    'enable',
      detect_face:    'enable',
      resolution:     512,
      bbox_detector:  BBOX_DETECTOR,
      pose_estimator: POSE_ESTIMATOR,
    },
  };
  workflow[saveId] = { ...saveNode, inputs: { ...saveNode.inputs, images: ['990', 0] } };
  return workflow;
}

// Returns { ref, imageUrl } — ref is a ComfyUI input ref for the skeleton,
// imageUrl the app-relative URL for the UI. Throws a human-readable Error on
// any failure — a workflow that asked for a pose must not silently continue
// without one, so callers let these errors fail the step.
async function generatePose({ cfg, poseModelConfig, prompt, width, height, onProgress }) {
  if (!await comfyui.hasNode(DWPOSE_NODE)) {
    throw new Error(`Pose generation failed: ${DWPOSE_NODE} node not found — install comfyui_controlnet_aux`);
  }

  const graph = buildPoseGraph(poseModelConfig, prompt, { width, height });
  const { images } = await comfyui.generate(graph, onProgress, null);
  if (!images.length) throw new Error('Pose generation failed: draft run produced no image');

  const img     = images[0];
  const sub     = encodeURIComponent(img.subfolder ?? '');
  const type    = encodeURIComponent(img.type ?? 'output');
  const name    = encodeURIComponent(img.filename);
  const viewRes = await fetch(`${cfg.comfyuiUrl}/view?filename=${name}&subfolder=${sub}&type=${type}`);
  if (!viewRes.ok) throw new Error(`Pose generation failed: could not fetch skeleton image (${viewRes.status})`);

  // DWPose outputs an all-black canvas when it finds no person in the draft
  // (e.g. extreme close-ups with no detectable body). Feeding that to the
  // ControlNet would silently condition on nothing — fail loudly instead.
  const skeleton = Buffer.from(await viewRes.arrayBuffer());
  if (png.isBlank(skeleton)) {
    throw new Error('Pose generation failed: no person detected in the draft (empty pose guide)');
  }

  const ref = await comfyui.uploadImage(skeleton, `pose_${Date.now()}.png`);
  return { ref, imageUrl: `/api/image?filename=${name}&subfolder=${sub}&type=${type}` };
}

module.exports = { buildPoseGraph, generatePose, DWPOSE_NODE };

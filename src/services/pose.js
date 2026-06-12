'use strict';

// Pose pre-pass: generate a quick draft with a dedicated pose model, extract an
// OpenPose skeleton via DWPose (comfyui_controlnet_aux), and re-upload it as a
// ComfyUI input for use as the ControlNet conditioning image.
// One ComfyUI run: the draft graph's SaveImage is rewired through DWPose, so
// the run's output IS the skeleton.

const comfyui = require('./comfyui');
const { buildWorkflow: buildArchWorkflow } = require('../workflows');

// ⚠ Node/model names below are the comfyui_controlnet_aux defaults — verify
// against the installed pack's object_info (same caveat as the LLLite nodes).
const DWPOSE_NODE    = 'DWPreprocessor';
const BBOX_DETECTOR  = 'yolox_l.onnx';
const POSE_ESTIMATOR = 'dw-ll_ucoco_384_bs5.torchscript.pt';

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
// any failure; callers treat pose failures as non-fatal warnings.
async function generatePose({ cfg, poseModelConfig, prompt, width, height, onProgress }) {
  if (!await comfyui.hasNode(DWPOSE_NODE)) {
    throw new Error(`Pose skipped: ${DWPOSE_NODE} node not found — install comfyui_controlnet_aux`);
  }

  const graph = buildPoseGraph(poseModelConfig, prompt, { width, height });
  const { images } = await comfyui.generate(graph, onProgress, null);
  if (!images.length) throw new Error('Pose skipped: draft run produced no image');

  const img     = images[0];
  const sub     = encodeURIComponent(img.subfolder ?? '');
  const type    = encodeURIComponent(img.type ?? 'output');
  const name    = encodeURIComponent(img.filename);
  const viewRes = await fetch(`${cfg.comfyuiUrl}/view?filename=${name}&subfolder=${sub}&type=${type}`);
  if (!viewRes.ok) throw new Error(`Pose skipped: failed to fetch skeleton image (${viewRes.status})`);

  const ref = await comfyui.uploadImage(Buffer.from(await viewRes.arrayBuffer()), `pose_${Date.now()}.png`);
  return { ref, imageUrl: `/api/image?filename=${name}&subfolder=${sub}&type=${type}` };
}

module.exports = { buildPoseGraph, generatePose, DWPOSE_NODE };

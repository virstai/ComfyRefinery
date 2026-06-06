'use strict';

const comfyui  = require('../services/comfyui');
const { buildWorkflow: buildArchWorkflow, getDefaults } = require('../workflows');

// ── Helpers ───────────────────────────────────────────────────────────────────

// Infer native upscale factor from model name (e.g. "4x-UltraSharp.pth" → 4).
function nativeScale(modelName) {
  const m = modelName?.match(/(\d+)x/i);
  return m ? parseInt(m[1], 10) : 4;
}

// Fetch previous step's output from ComfyUI and re-upload as an input ref.
async function fetchAndUpload(ctx) {
  if (!ctx.inputImage) throw new Error('Upscale step requires an input image from a previous step');

  const url       = new URL(ctx.inputImage, 'http://localhost');
  const filename  = url.searchParams.get('filename') ?? 'image.png';
  const subfolder = url.searchParams.get('subfolder') ?? '';
  const type      = url.searchParams.get('type') ?? 'output';

  const fetchUrl = `${ctx.cfg.comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`Failed to fetch input image for upscale: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  return comfyui.uploadImage(buffer, filename);
}

// Inject a LatentUpscaleBy node between VAEEncode output and KSampler(s).
// Mutates the workflow object in-place.
function injectLatentUpscale(workflow, scale) {
  const vaeEncodeEntry = Object.entries(workflow).find(([, n]) => n.class_type === 'VAEEncode');
  if (!vaeEncodeEntry) return;
  const [vaeEncodeId] = vaeEncodeEntry;

  const newId = String(Math.max(...Object.keys(workflow).map(Number)) + 1);
  workflow[newId] = {
    class_type: 'LatentUpscaleBy',
    inputs: { samples: [vaeEncodeId, 0], upscale_method: 'nearest-exact', scale_by: scale },
  };

  for (const node of Object.values(workflow)) {
    if (
      (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced') &&
      Array.isArray(node.inputs.latent_image) &&
      node.inputs.latent_image[0] === vaeEncodeId
    ) {
      node.inputs.latent_image = [newId, 0];
    }
  }
}

// ── Step interface ────────────────────────────────────────────────────────────

function label(stepDef, cfg) {
  const upscaleType = stepDef.upscaleType ?? 'model';
  if (upscaleType === 'hires') {
    const modelLabel = cfg?.models?.[stepDef.modelId]?.label ?? stepDef.modelId ?? 'hires';
    return `${modelLabel} hires ×${stepDef.scale ?? 2}`;
  }
  return `${stepDef.upscaleModel ?? 'upscale'} ×${stepDef.factor ?? 2}`;
}

async function prepare(_stepDef, ctx) {
  const inputRef = await fetchAndUpload(ctx);
  return { inputRef };
}

function buildComfyWorkflow(stepDef, prepareResult, ctx) {
  const upscaleType = stepDef.upscaleType ?? 'model';
  return upscaleType === 'hires'
    ? buildHiresWorkflow(stepDef, prepareResult, ctx)
    : buildModelWorkflow(stepDef, prepareResult);
}

function reviewMessages(stepDef, _prepareResult, ctx, imageBase64, previousIterations) {
  const upscaleType = stepDef.upscaleType ?? 'model';
  const context = previousIterations.length > 0
    ? ` This is attempt ${previousIterations.length + 1} after ${previousIterations.length} previous rejection(s).`
    : '';

  const criteria = upscaleType === 'hires'
    ? 'Check for: coherent detail enhancement, unwanted content changes, over-sharpening, and whether the image faithfully represents the original prompt at higher detail.'
    : 'Check for: sharpness, halos around edges, ringing artifacts, noise amplification, and loss of fine detail.';

  return [
    {
      role: 'system',
      content:
        `You are reviewing an upscaled image.${context} ${criteria}\n\n` +
        `You must always end your response with exactly these two lines — no exceptions:\n` +
        `VERDICT: ACCEPT or REJECT\n` +
        `DIAGNOSIS: one sentence on the main issue (or "looks good")`,
    },
    {
      role: 'user',
      content: `Original prompt: ${ctx.userPrompt}\n\nReview this upscaled image:`,
      images: [imageBase64],
    },
  ];
}

// ── Workflow builders ─────────────────────────────────────────────────────────

function buildModelWorkflow(stepDef, prepareResult) {
  const { inputRef } = prepareResult;
  const modelName = stepDef.upscaleModel ?? '';
  const factor    = stepDef.factor ?? 2;
  const native    = nativeScale(modelName);

  const imgPath = inputRef.subfolder
    ? `${inputRef.subfolder}/${inputRef.filename}`
    : inputRef.filename;

  const nodes = {
    "1": { class_type: "UpscaleModelLoader",    inputs: { model_name: modelName } },
    "2": { class_type: "LoadImage",             inputs: { image: imgPath } },
    "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["1", 0], image: ["2", 0] } },
  };

  let imageRef = ["3", 0];
  let nextId   = 4;

  if (factor < native) {
    nodes[String(nextId)] = {
      class_type: "ImageScaleBy",
      inputs: { image: imageRef, upscale_method: "lanczos", scale_by: factor / native },
    };
    imageRef = [String(nextId), 0];
    nextId++;
  }

  nodes[String(nextId)] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: "iterator", images: imageRef },
  };

  return nodes;
}

function buildHiresWorkflow(stepDef, prepareResult, ctx) {
  const { inputRef } = prepareResult;
  const modelConfig  = ctx.cfg.models?.[stepDef.modelId];
  if (!modelConfig) throw new Error(`Hires upscale: model "${stepDef.modelId}" not found in config`);

  const archDefaults = getDefaults(modelConfig.architecture);
  const params = {
    ...archDefaults,
    ...modelConfig,
    positivePrompt: ctx.userPrompt ?? '',
    initImage:  inputRef,
    denoise:    stepDef.denoise   ?? 0.35,
    steps:      stepDef.steps     ?? archDefaults.steps,
    cfgScale:   stepDef.cfgScale  ?? archDefaults.cfgScale,
    sampler:    stepDef.sampler   ?? archDefaults.sampler,
    scheduler:  stepDef.scheduler ?? archDefaults.scheduler,
  };

  const { workflow } = buildArchWorkflow(modelConfig, params);
  injectLatentUpscale(workflow, stepDef.scale ?? 2);
  return workflow;
}

module.exports = { label, prepare, buildComfyWorkflow, reviewMessages };

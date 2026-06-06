'use strict';

const comfyui = require('../services/comfyui');
const { buildWorkflow, getDefaults, archMeta } = require('../workflows');

function label(stepDef, cfg) {
  const modelConfig = cfg?.models?.[stepDef.modelId];
  const modelLabel  = modelConfig?.label ?? stepDef.modelId ?? 'video';
  const params      = stepDef.params ?? {};
  const arch        = modelConfig?.architecture;
  const archDefs    = arch ? getDefaults(arch) : {};
  const frames      = params.frames ?? archDefs.frames ?? '?';
  const fps         = params.fps    ?? archDefs.fps    ?? '?';
  return `${modelLabel} ×${frames}f @ ${fps}fps`;
}

async function prepare(stepDef, ctx) {
  // Priority: previous step output → first reference → T2V (no init image)
  if (ctx.inputImage) {
    const url       = new URL(ctx.inputImage, 'http://localhost');
    const filename  = url.searchParams.get('filename') ?? 'image.png';
    const subfolder = url.searchParams.get('subfolder') ?? '';
    const type      = url.searchParams.get('type') ?? 'output';

    const { comfyuiUrl } = ctx.cfg;
    const fetchUrl = `${comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`Failed to fetch init image for video: ${res.status}`);
    const buffer   = Buffer.from(await res.arrayBuffer());
    const inputRef = await comfyui.uploadImage(buffer, filename);
    return { inputRef, isI2V: true };
  }

  if (ctx.references?.length) {
    const ref = ctx.references[0];
    return {
      inputRef: { filename: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'input' },
      isI2V: true,
    };
  }

  return { inputRef: null, isI2V: false };
}

function buildComfyWorkflow(stepDef, prepareResult, ctx) {
  const modelConfig = ctx.modelConfig;
  if (!modelConfig) throw new Error('Video step: modelConfig not set on ctx');

  const arch = modelConfig.architecture;
  const meta = archMeta[arch];
  if (!meta?.videoArch) throw new Error(`Architecture "${arch}" is not a video architecture`);

  const archDefaults = getDefaults(arch);
  const params = {
    ...archDefaults,
    ...modelConfig,
    ...(stepDef.params ?? {}),
    positivePrompt: ctx.userPrompt ?? '',
    inputRef:       prepareResult.inputRef,
    isI2V:          prepareResult.isI2V,
  };

  const { workflow } = buildWorkflow(modelConfig, params);
  return workflow;
}

module.exports = { label, prepare, buildComfyWorkflow };

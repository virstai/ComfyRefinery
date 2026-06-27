'use strict';

const comfyui  = require('../services/comfyui');
const llm      = require('../services/llm');
const skills   = require('../services/skills');
const { buildWorkflow, getDefaults, archMeta } = require('../workflows');
const { parsePromptResponse } = require('../lib/parsers');
const { LOCAL_PREAMBLE }      = require('../services/skillRefresher');

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

function buildVideoMessages(userPrompt, architecture, isI2V, context) {
  const medium = isI2V ? 'image-to-video' : 'text-to-video';
  return [
    {
      role: 'system',
      content:
        `${LOCAL_PREAMBLE}\n\n` +
        `You are an expert at writing video generation prompts for ${architecture.toUpperCase()} models. ` +
        `This is a ${medium} generation. ` +
        `Convert the user description into the most effective prompt for this video model. ` +
        `Video prompts should describe motion, camera movement, and scene dynamics alongside visual content. ` +
        `Output only the prompt text — no preamble, no explanation, no labels.` +
        (context ? `\n\n${context}` : ''),
    },
    { role: 'user', content: `Description: ${userPrompt}` },
  ];
}

// Resolve an uploaded ComfyUI input ref into a base64 string for vision context.
async function fetchRefBase64(inputRef, comfyuiUrl) {
  try {
    const url = `${comfyuiUrl}/view?filename=${encodeURIComponent(inputRef.filename)}&subfolder=${encodeURIComponent(inputRef.subfolder ?? '')}&type=${encodeURIComponent(inputRef.type ?? 'input')}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch {
    return null;
  }
}

// prepare() resolves the init image (if any) and builds the LLM-refined prompt.
// _previousIterations is accepted but unused — video steps run once with no review loop.
async function prepare(stepDef, ctx, _previousIterations, onToken) {
  const { userPrompt, modelConfig, skillId, cfg } = ctx;
  const { architecture } = modelConfig;

  // ── Resolve init image (priority: previous step output → first reference) ──
  let inputRef = null;
  let isI2V    = false;

  if (ctx.inputImage) {
    const url       = new URL(ctx.inputImage, 'http://localhost');
    const filename  = url.searchParams.get('filename') ?? 'image.png';
    const subfolder = url.searchParams.get('subfolder') ?? '';
    const type      = url.searchParams.get('type') ?? 'output';

    const fetchUrl = `${cfg.comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`Failed to fetch init image for video: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    inputRef = await comfyui.uploadImage(buffer, filename);
    isI2V    = true;
  } else if (ctx.references?.length) {
    const ref = ctx.references[0];
    inputRef  = { filename: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'input' };
    isI2V     = true;
  }

  // ── Prompt refinement ────────────────────────────────────────────────────
  if (cfg.promptRefinement === false) {
    return { prompt: userPrompt, inputRef, isI2V };
  }

  const skillSummary = cfg.skillRefinement !== false ? skills.getSummary(skillId) : null;
  const messages = buildVideoMessages(userPrompt, architecture, isI2V, skillSummary);

  // For I2V: inject the init image so the LLM can describe it and suggest
  // motion that fits the content — inserted before the user description.
  if (isI2V && inputRef && cfg.llmExtras !== false) {
    const b64 = await fetchRefBase64(inputRef, cfg.comfyuiUrl);
    if (b64) {
      messages.splice(1, 0, {
        role: 'user',
        content: 'Reference image for this video generation:',
        images: [b64],
      });
    }
  }

  let builtPrompt = userPrompt;
  try {
    const result = await llm.chatStream(cfg, messages, token => onToken?.(token), { signal: ctx.signal });
    const text   = typeof result === 'string' ? result : result.text;
    builtPrompt  = parsePromptResponse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('[video] prompt build failed, falling back to raw prompt:', e.message);
  }

  return { prompt: builtPrompt, inputRef, isI2V };
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
    positivePrompt: prepareResult.prompt ?? ctx.userPrompt ?? '',
    inputRef:       prepareResult.inputRef,
    isI2V:          prepareResult.isI2V,
  };

  const { workflow } = buildWorkflow(modelConfig, params);
  return workflow;
}

module.exports = { label, prepare, buildComfyWorkflow };

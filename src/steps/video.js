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

function buildVideoMessages(userPrompt, architecture, { isI2V, refCount = 0 }, context) {
  const medium = refCount > 0 ? 'reference-to-video' : isI2V ? 'image-to-video' : 'text-to-video';
  const refGuidance = refCount > 0
    ? `${refCount} reference image${refCount !== 1 ? 's are' : ' is'} provided. ` +
      `Cite each one in the prompt as <Picture 1>${refCount > 1 ? ` through <Picture ${refCount}>` : ''} ` +
      `and assign it an explicit role — identity (a person or character to keep consistent), style, or scene/object. ` +
      `Example: "The woman from <Picture 1> walks through the market, rendered in the painterly style of <Picture 2>." `
    : '';
  return [
    {
      role: 'system',
      content:
        `${LOCAL_PREAMBLE}\n\n` +
        `You are an expert at writing video generation prompts for ${architecture.toUpperCase()} models. ` +
        `This is a ${medium} generation. ` +
        refGuidance +
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

  // ── Resolve inputs ───────────────────────────────────────────────────────
  // Priority: previous step output → I2V; else uploaded references → R2V when
  // the arch + model support reference-to-video, otherwise refs[0] as I2V init.
  let inputRef      = null;
  let isI2V         = false;
  let referenceRefs = [];
  let isR2V         = false;

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
    if (archMeta[architecture]?.referenceToVideo && modelConfig.refUnetName) {
      referenceRefs = ctx.references.map(ref => ({ filename: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'input' }));
      isR2V = true;
    } else {
      const ref = ctx.references[0];
      inputRef  = { filename: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'input' };
      isI2V     = true;
    }
  }

  // ── Prompt refinement ────────────────────────────────────────────────────
  if (cfg.promptRefinement === false) {
    return { prompt: userPrompt, inputRef, isI2V, referenceRefs, isR2V };
  }

  const skillSummary = cfg.skillRefinement !== false ? skills.getSummary(skillId) : null;
  const messages = buildVideoMessages(userPrompt, architecture, { isI2V, refCount: referenceRefs.length }, skillSummary);

  // Inject the input image(s) so the LLM can describe them and suggest motion
  // that fits the content — inserted before the user description.
  if (cfg.llmExtras !== false) {
    const visionRefs = isR2V ? referenceRefs : (isI2V && inputRef ? [inputRef] : []);
    const images = (await Promise.all(visionRefs.map(r => fetchRefBase64(r, cfg.comfyuiUrl)))).filter(Boolean);
    if (images.length) {
      messages.splice(1, 0, {
        role: 'user',
        content: isR2V
          ? `Reference images for this video generation, in order (<Picture 1>…<Picture ${images.length}>):`
          : 'Reference image for this video generation:',
        images,
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

  return { prompt: builtPrompt, inputRef, isI2V, referenceRefs, isR2V };
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
    referenceRefs:  prepareResult.referenceRefs ?? [],
    isR2V:          prepareResult.isR2V ?? false,
  };

  const { workflow } = buildWorkflow(modelConfig, params);
  return workflow;
}

module.exports = { label, prepare, buildComfyWorkflow };

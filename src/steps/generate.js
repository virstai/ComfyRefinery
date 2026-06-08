'use strict';

const llm    = require('../services/llm');
const skills = require('../services/skills');
const { buildWorkflow: buildArchWorkflow, getDefaults } = require('../workflows');
const { parsePromptResponse } = require('../lib/parsers');
const { LOCAL_PREAMBLE } = require('../services/skillRefresher');

function label(stepDef, cfg) {
  return cfg?.models?.[stepDef.modelId]?.label ?? stepDef.modelId ?? 'Generate';
}

function buildInitialMessages(userPrompt, architecture, archDefaults, skillSummary) {
  return [
    {
      role: 'system',
      content:
        `${LOCAL_PREAMBLE}\n\n` +
        `You are an expert at writing image generation prompts for ${architecture.toUpperCase()} models in ComfyUI. ` +
        `Convert the user description into the most effective prompt for this model. ` +
        `Output only the prompt text — no preamble, no explanation, no labels.` +
        (skillSummary ? `\n\n${skillSummary}` : ''),
    },
    { role: 'user', content: `Description: ${userPrompt}\n\nDefault resolution: ${archDefaults.width}x${archDefaults.height}` },
  ];
}

function buildRefinementMessages(userPrompt, iterations, architecture, skillSummary) {
  const history = iterations.map((it, i) => {
    let entry = `Iteration ${i + 1}:\n  Prompt: ${it.prompt}\n  Verdict: ${it.verdict}\n  Diagnosis: ${it.diagnosis}`;
    if (it.humanFeedback) entry += `\n  Human feedback: ${it.humanFeedback}`;
    return entry;
  }).join('\n\n');

  const last = iterations[iterations.length - 1];

  return [
    {
      role: 'system',
      content:
        `${LOCAL_PREAMBLE}\n\n` +
        `You are an expert at writing image generation prompts for ${architecture.toUpperCase()} models in ComfyUI. ` +
        `Previous attempts have not fully satisfied the description. Analyse what went wrong and produce an improved prompt. ` +
        `Output only the prompt text — no preamble, no explanation, no labels.` +
        (skillSummary ? `\n\n${skillSummary}` : ''),
    },
    {
      role: 'user',
      content:
        `Original description: ${userPrompt}\n\n` +
        `Attempt history:\n${history}\n\n` +
        `Last diagnosis: ${last.diagnosis}\n\n` +
        `Write an improved prompt:`,
    },
  ];
}

function buildReviewMessages(userPrompt, prompt, architecture, previousIterations, imageBase64, skillSummary) {
  const context = previousIterations.length > 0
    ? `\n\nPrevious attempts failed. This is attempt ${previousIterations.length + 1}.`
    : '';

  const skillNote = skillSummary
    ? `\n\nActive prompt constraints applied during generation (judge the image with these in mind — do not penalise for intentional style adaptations):\n${skillSummary}`
    : '';

  return [
    {
      role: 'system',
      content:
        `${LOCAL_PREAMBLE}\n\n` +
        `You are reviewing a generated image for a ${architecture.toUpperCase()} model in ComfyUI. ` +
        `Look at the attached image and assess whether it satisfies the original description. ` +
        `If rejecting, diagnose specifically what is wrong: content issues, missing elements, or wrong style.${context}${skillNote}\n\n` +
        `You must always end your response with exactly these two lines — no exceptions:\n` +
        `VERDICT: ACCEPT or REJECT\n` +
        `DIAGNOSIS: one sentence on the main issue (or "looks good")`,
    },
    {
      role: 'user',
      content: `Description: ${userPrompt}\nPrompt: ${prompt}\n\nReview the generated image:`,
      images: [imageBase64],
    },
  ];
}

// Run the LLM to build/refine the prompt; return resolved generation params.
async function prepare(stepDef, ctx, previousIterations, onToken) {
  const { userPrompt, modelConfig, skillId, cfg } = ctx;
  const { architecture } = modelConfig;
  const archDefaults = getDefaults(architecture);
  const skillSummary = skills.getSummary(skillId);

  const messages = previousIterations.length === 0
    ? buildInitialMessages(userPrompt, architecture, archDefaults, skillSummary)
    : buildRefinementMessages(userPrompt, previousIterations, architecture, skillSummary);

  // Vision notes: inject reference images as base64 so the LLM can use them as
  // compositional guidance when building the prompt.
  // ctx.imageContext — already-decoded base64 strings (e.g. from A1111 init_images), used directly.
  // ctx.references  — ComfyUI input refs that must be fetched from ComfyUI first.
  // Both sources are combined; either can be empty.
  const refs = ctx.references ?? [];
  if (stepDef.referenceStrategy?.visionNotes && (refs.length > 0 || ctx.imageContext?.length > 0)) {
    const direct  = ctx.imageContext ?? [];
    const fetched = await Promise.all(refs.map(async ref => {
      const url = `${cfg.comfyuiUrl}/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder ?? '')}&type=${encodeURIComponent(ref.type ?? 'input')}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Failed to fetch reference image: ${r.status}`);
      return Buffer.from(await r.arrayBuffer()).toString('base64');
    }));
    const refImages = [...direct, ...fetched];
    if (refImages.length) {
      messages.splice(1, 0, { role: 'user', content: 'Reference images for composition guidance:', images: refImages });
    }
  }

  const raw    = await llm.chatStream(cfg, messages, onToken, { signal: ctx.signal });
  const prompt = parsePromptResponse(raw);

  const params = {
    ...archDefaults,
    ...modelConfig,
    ...(stepDef.params ?? {}),
    positivePrompt: prompt,
  };

  return { prompt, params };
}

// Build the ComfyUI workflow graph for this iteration.
function buildComfyWorkflow(stepDef, prepareResult, ctx) {
  const rs   = stepDef.referenceStrategy?.diffusion;
  const refs = ctx.references ?? [];
  const mode = rs?.mode;

  let initImage = null;
  let denoise   = 0.6;

  if (refs.length > 0 && mode === 'init-image') {
    initImage = refs[0];
    denoise   = rs.denoise ?? prepareResult.params.denoise ?? 0.6;
  }

  // Chain previous step's output as init-image when no reference override is active
  if (!initImage && ctx.chainedInputRef) {
    initImage = ctx.chainedInputRef;
    denoise   = stepDef.params?.chainDenoise ?? 0.5;
  }

  // Adapter mode: pass refs to the arch builder. adapterModel/clipVisionModel come from
  // ctx.modelConfig (already spread by buildArchWorkflow), so only the images are explicit.
  let adapterParams = {};
  if (refs.length > 0 && mode === 'adapter') {
    const arch = ctx.modelConfig?.architecture;
    if (arch === 'sd15' || arch === 'sdxl' || arch === 'anima') {
      adapterParams = { ipAdapterImages: refs };
    } else if (arch === 'flux') {
      adapterParams = { reduxImages: refs };
    } else if (arch === 'flux2') {
      adapterParams = { referenceImages: refs }; // native ReferenceLatent, no adapter model needed
    }
    // Other archs: no adapter defined, falls through to txt2img
  }

  const { workflow } = buildArchWorkflow(ctx.modelConfig, {
    ...prepareResult.params,
    ...(initImage ? { initImage, denoise } : {}),
    ...adapterParams,
  });
  return workflow;
}

// Return the LLM review messages for this iteration.
function reviewMessages(stepDef, prepareResult, ctx, imageBase64, previousIterations) {
  const { userPrompt, modelConfig, skillId } = ctx;
  const skillSummary = skills.getSummary(skillId);
  return buildReviewMessages(
    userPrompt, prepareResult.prompt, modelConfig.architecture,
    previousIterations, imageBase64, skillSummary,
  );
}

module.exports = { label, prepare, buildComfyWorkflow, reviewMessages };

'use strict';

const express          = require('express');
const router           = express.Router();
const { EventEmitter } = require('events');
const { v4: uuidv4 }  = require('uuid');
const config  = require('../services/config');
const llm     = require('../services/llm');
const comfyui = require('../services/comfyui');
const skills  = require('../services/skills');
const db      = require('../services/db');
const videoTake = require('../services/videoTake');
const { refreshSkill } = require('../services/skillRefresher');
const steps   = require('../steps');
const { archMeta } = require('../workflows');
const { parseReview } = require('../lib/parsers');

const sessions           = new Map(); // active sessions (in-memory cache)
const pendingReviews     = new Map(); // `${sessionId}:${stepIndex}` → { resolve, reject }
const pendingAcceptances = new Map(); // `${sessionId}:${stepIndex}` → { resolve, timer }
const activeKills        = new Map(); // sessionId → kill function

// Broadcast channel — all SSE clients subscribed to GET /events receive every event.
const genEmitter = new EventEmitter();
genEmitter.setMaxListeners(100);

function emit(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  genEmitter.emit('gen', event, data);
}

// The iteration whose output feeds the next step: the user-selected one when set,
// otherwise the most recent.
function stepOutput(stepData) {
  if (!stepData?.iterations?.length) return null;
  const sel = stepData.selectedIteration;
  return (sel >= 1 && sel <= stepData.iterations.length)
    ? stepData.iterations[sel - 1]
    : stepData.iterations[stepData.iterations.length - 1];
}

function waitForHumanReview(key) {
  return new Promise((resolve, reject) => {
    pendingReviews.set(key, { resolve, reject });
  });
}

function waitForAcceptanceGrace(key, seconds) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingAcceptances.delete(key);
      resolve(false);
    }, seconds * 1000);
    pendingAcceptances.set(key, { resolve, timer });
  });
}

// ── Step execution ────────────────────────────────────────────────────────────────

async function _runIterativeLoop(stepType, stepDef, stepIndex, session, ctx, cfg, res, isKilled = () => false) {
  const stepData = session.steps[stepIndex];
  const tag      = session.id.slice(0, 8);

  // Per-step review settings, falling back to global config
  const review          = stepDef.review ?? {};
  const reviewEnabled   = cfg.reviewEnabled !== false;
  const maxNewIter      = !reviewEnabled ? 1 : (review.maxIterations ?? cfg.maxIterations ?? 4);
  const humanReview     = !reviewEnabled ? false : (review.humanReview ?? cfg.humanReview ?? false);
  const gracePeriod     = !reviewEnabled ? 0 : cfg.bypassGracePeriod ? 0
    : review.gracePeriod !== undefined ? review.gracePeriod : (cfg.acceptanceGracePeriod ?? 0);
  const pendingKey  = `${session.id}:${stepIndex}`;

  emit(res, 'step', { index: stepIndex, type: stepDef.type, label: stepData.label, total: session.steps.length });
  console.log(`[${tag}] step ${stepIndex} (${stepDef.type}: ${stepData.label}) maxIter=${maxNewIter}`);

  let accepted     = false;
  let continueLoop = true;

  while (continueLoop) {
    continueLoop = false;

    for (let i = 0; i < maxNewIter && !accepted; i++) {
      if (isKilled()) throw new Error('Generation stopped by user');
      const iterNum = stepData.iterations.length + 1;

      // ── Phase 1: prepare ──────────────────────────────────────────
      emit(res, 'phase', { step: stepIndex, phase: 'prompt_building', iteration: iterNum });
      console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: preparing…`);

      const prepResult = await stepType.prepare(stepDef, ctx, stepData.iterations, token => {
        emit(res, 'token', { step: stepIndex, iteration: iterNum, phase: 'prompt', token });
        process.stdout.write(token);
      });
      process.stdout.write('\n');

      if (isKilled()) throw new Error('Generation stopped by user');

      if (prepResult.prompt !== undefined) {
        const preview = prepResult.prompt;
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: prompt="${preview.slice(0, 80)}${preview.length > 80 ? '…' : ''}"`);
        emit(res, 'prompt', { step: stepIndex, iteration: iterNum, prompt: prepResult.prompt });
      }

      // Tool-interpretation warnings from prepare (unknown loras etc.)
      for (const w of prepResult.warnings ?? []) {
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: ${w}`);
        emit(res, 'warning', { step: stepIndex, iteration: iterNum, message: w });
      }

      // ── Phase 1.5: pre-pass (pose ControlNet) ─────────────────────
      // A wanted-but-failed pose throws here and fails the step: a workflow
      // that asked for pose control must not silently generate without it.
      if (typeof stepType.prePass === 'function') {
        const pre = await stepType.prePass(stepDef, prepResult, ctx, {
          onStart: () => {
            emit(res, 'phase', { step: stepIndex, phase: 'posing', iteration: iterNum });
            console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: generating pose guide…`);
          },
          onProgress: pct => emit(res, 'progress', { step: stepIndex, iteration: iterNum, pct }),
        });
        if (isKilled()) throw new Error('Generation stopped by user');
        if (pre?.poseImageUrl) {
          emit(res, 'pose', { step: stepIndex, iteration: iterNum, url: pre.poseImageUrl });
        }
      }

      // ── Phase 2: generate ─────────────────────────────────────────
      emit(res, 'phase', { step: stepIndex, phase: 'generating', iteration: iterNum });
      console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: queuing ComfyUI job…`);

      // Pick the sampling seed here (instead of inside the arch builder) so it
      // can be recorded on the iteration for reproducibility.
      if (prepResult.params && typeof prepResult.params === 'object' && prepResult.params.seed == null) {
        prepResult.params.seed = Math.floor(Math.random() * 2 ** 32);
      }

      const workflow = stepType.buildComfyWorkflow(stepDef, prepResult, ctx);
      const { images } = await comfyui.generate(
        workflow,
        pct => {
          emit(res, 'progress', { step: stepIndex, iteration: iterNum, pct });
          process.stdout.write(`\r[${tag}] step ${stepIndex} iter ${iterNum}: generating ${pct}%   `);
        },
        previewUrl => emit(res, 'preview', { step: stepIndex, iteration: iterNum, url: previewUrl }),
        { signal: ctx.signal },
      );
      process.stdout.write('\n');

      if (isKilled()) throw new Error('Generation stopped by user');
      if (!images.length) throw new Error('ComfyUI returned no images');
      const image    = images[0];
      const imageUrl = `/api/image?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? '')}&type=${encodeURIComponent(image.type ?? 'output')}`;
      console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: image ready — ${image.filename}`);
      emit(res, 'image', { step: stepIndex, iteration: iterNum, url: imageUrl });

      const imgFetchUrl = `${cfg.comfyuiUrl}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder ?? '')}&type=${encodeURIComponent(image.type ?? 'output')}`;

      // ── Phase 3: review ───────────────────────────────────────────
      // Deterministic steps (e.g. model upscales) skip the LLM review: the
      // same input always produces the same output, so a rejection could
      // never be fixed by re-running.
      // Generate steps also skip review on the last allowed iteration:
      // reviewing when no further retry is possible is wasteful.
      const isLastIteration = i === maxNewIter - 1;
      let verdict, diagnosis;
      if (stepType.skipReview?.(stepDef) || !reviewEnabled) {
        verdict   = 'ACCEPT';
        diagnosis = !reviewEnabled ? 'review disabled in settings' : 'deterministic step — review skipped';
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: review skipped (${!reviewEnabled ? 'disabled' : 'deterministic'})`);
      } else if (stepDef.type === 'generate' && isLastIteration) {
        verdict   = 'ACCEPT';
        diagnosis = 'last iteration — review skipped';
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: review skipped (last iteration)`);
      } else {
        emit(res, 'phase', { step: stepIndex, phase: 'reviewing', iteration: iterNum });
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: reviewing…`);

        // Fetch image as base64 for vision review
        const imgRes = await fetch(imgFetchUrl);
        if (!imgRes.ok) throw new Error(`Failed to fetch image for review: ${imgRes.status}`);
        const imageBase64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');

        const reviewMsgs = stepType.reviewMessages(stepDef, prepResult, ctx, imageBase64, stepData.iterations);
        const reviewRaw  = await llm.chatStream(cfg, reviewMsgs, token => {
          emit(res, 'token', { step: stepIndex, iteration: iterNum, phase: 'review', token });
          process.stdout.write(token);
        }, { signal: ctx.signal });
        process.stdout.write('\n');

        if (isKilled()) throw new Error('Generation stopped by user');
        ({ verdict, diagnosis } = parseReview(reviewRaw));
      }
      console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: verdict=${verdict} — ${diagnosis}`);
      emit(res, 'review', { step: stepIndex, iteration: iterNum, verdict, diagnosis,
        ...(prepResult.loras?.length ? { loras: prepResult.loras } : {}),
        ...(prepResult.poseImageUrl  ? { poseUsed: true }          : {}) });

      const iteration = { prompt: prepResult.prompt, imageUrl, verdict, diagnosis };
      if (prepResult.params?.seed != null) iteration.seed = prepResult.params.seed;
      if (prepResult.loras?.length) iteration.loras = prepResult.loras;
      if (prepResult.poseImageUrl) {
        iteration.poseUsed     = true;
        iteration.poseImageUrl = prepResult.poseImageUrl;
      }
      if (prepResult.warnings?.length) iteration.warnings = [...prepResult.warnings];
      stepData.iterations.push(iteration);
      accepted = verdict === 'ACCEPT';

      // ── Phase 4: human review ─────────────────────────────────────
      if (humanReview) {
        emit(res, 'human_review', { step: stepIndex, iteration: iterNum, aiVerdict: verdict, aiDiagnosis: diagnosis });
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: awaiting human review…`);
        const decision = await waitForHumanReview(pendingKey);
        if (decision.feedback) iteration.humanFeedback = decision.feedback;
        accepted = decision.accept;
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: human ${decision.accept ? 'ACCEPTED' : 'REJECTED'}`);
        emit(res, 'human_verdict', { step: stepIndex, iteration: iterNum, accepted: decision.accept, feedback: decision.feedback });
      }

      // ── Phase 5: acceptance grace period ──────────────────────────
      if (accepted && gracePeriod > 0) {
        emit(res, 'accepted_pending', { step: stepIndex, iteration: iterNum, gracePeriod, humanReview });
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: grace period ${gracePeriod}s…`);
        const refused = await waitForAcceptanceGrace(pendingKey, gracePeriod);
        if (refused) {
          accepted = false;
          iteration.verdict = 'REFUSED';
          emit(res, 'acceptance_refused', { step: stepIndex, iteration: iterNum });
          console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: acceptance refused — continuing`);
        }
      }

      if (stepDef.type === 'generate') {
        skills.record(ctx.modelConfig.id, ctx.modelConfig.label, ctx.modelConfig.architecture, accepted ? 'ACCEPT' : 'REJECT');
      }
      db.saveSession(session);
    }

    // Grace period at max iterations — let user refuse and keep iterating
    if (!accepted && gracePeriod > 0 && stepData.iterations.length > 0) {
      const lastIterNum = stepData.iterations.length;
      emit(res, 'accepted_pending', { step: stepIndex, iteration: lastIterNum, gracePeriod, humanReview, maxIterations: true });
      console.log(`[${tag}] step ${stepIndex}: max iterations — grace period ${gracePeriod}s`);
      const refused = await waitForAcceptanceGrace(pendingKey, gracePeriod);
      if (refused) {
        stepData.iterations[lastIterNum - 1].verdict = 'REFUSED';
        emit(res, 'acceptance_refused', { step: stepIndex, iteration: lastIterNum });
        console.log(`[${tag}] step ${stepIndex}: grace period refused — continuing`);
        continueLoop = true;
      }
    }
  }

  // A fresh run supersedes any earlier manual variant selection on this step.
  stepData.selectedIteration = null;
  stepData.outputImageUrl = stepOutput(stepData)?.imageUrl ?? null;
  return { accepted, outputImageUrl: stepData.outputImageUrl };
}

async function runGenerateStep(stepDef, stepIndex, session, ctx, cfg, res, isKilled = () => false) {
  const modelConfig = cfg.models?.[stepDef.modelId];
  if (!modelConfig) throw new Error(`Model "${stepDef.modelId}" not found in config`);
  ctx = { ...ctx, modelConfig, skillId: modelConfig.id };

  if (ctx.inputImage) {
    try {
      const url       = new URL(ctx.inputImage, 'http://localhost');
      const filename  = url.searchParams.get('filename') ?? 'image.png';
      const subfolder = url.searchParams.get('subfolder') ?? '';
      const type      = url.searchParams.get('type') ?? 'output';
      const fetchUrl  = `${cfg.comfyuiUrl}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
      const imgRes    = await fetch(fetchUrl);
      if (imgRes.ok) {
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        ctx = { ...ctx, chainedInputRef: await comfyui.uploadImage(buffer, filename) };
      }
    } catch { /* chaining is best-effort */ }
  }

  const stepType = steps.get(stepDef.type);
  return _runIterativeLoop(stepType, stepDef, stepIndex, session, ctx, cfg, res, isKilled);
}

async function runUpscaleStep(stepDef, stepIndex, session, ctx, cfg, res, isKilled = () => false) {
  const stepType = steps.get(stepDef.type);
  return _runIterativeLoop(stepType, stepDef, stepIndex, session, ctx, cfg, res, isKilled);
}

async function runVideoStep(stepDef, stepIndex, session, ctx, cfg, res, isKilled = () => false) {
  const stepType  = steps.get('video');
  const stepData  = session.steps[stepIndex];
  const tag       = session.id.slice(0, 8);

  const modelConfig = cfg.models?.[stepDef.modelId];
  if (!modelConfig) throw new Error(`Video model "${stepDef.modelId}" not found in config`);
  ctx = { ...ctx, modelConfig, skillId: modelConfig.id ?? stepDef.modelId };

  // Steering notes live on the session's step (set from the run view for the
  // next take); an ad-hoc step may also have been created with them.
  const steering = (stepData.steering ?? stepDef.steering ?? '').trim();
  if (steering) stepDef = { ...stepDef, steering };

  emit(res, 'step', { index: stepIndex, type: 'video', label: stepData.label, total: session.steps.length, steering: steering || null });
  console.log(`[${tag}] step ${stepIndex} (video: ${stepData.label})`);

  if (isKilled()) throw new Error('Generation stopped by user');

  // Each run of a video step appends a new take (variant), like image iterations.
  const iterNum = stepData.iterations.length + 1;

  emit(res, 'phase', { step: stepIndex, phase: 'prompt_building', iteration: iterNum });
  console.log(`[${tag}] step ${stepIndex}: building video prompt…`);

  const prepResult = await stepType.prepare(stepDef, ctx, stepData.iterations, token => {
    emit(res, 'token', { step: stepIndex, iteration: iterNum, phase: 'prompt', token });
  });

  if (isKilled()) throw new Error('Generation stopped by user');

  for (const w of prepResult.warnings ?? []) {
    emit(res, 'warning', { step: stepIndex, iteration: iterNum, message: w });
    console.warn(`[${tag}] step ${stepIndex}: ${w}`);
  }

  emit(res, 'prompt', { step: stepIndex, iteration: iterNum, prompt: prepResult.prompt });
  emit(res, 'phase',  { step: stepIndex, phase: 'generating', iteration: iterNum });
  console.log(`[${tag}] step ${stepIndex}: queuing video ComfyUI job…`);
  // Pick the seed here (as _runIterativeLoop does) so the take records it.
  prepResult.params = { ...(prepResult.params ?? {}), seed: videoTake.pickSeed(prepResult.params) };
  const workflow = stepType.buildComfyWorkflow(stepDef, prepResult, ctx);

  // `progress` carries no iteration (as before); warning/video do.
  const { videoUrl, warnings: takeWarnings } = await videoTake.generateTake({
    workflow, cfg, signal: ctx.signal, isKilled, tag: `${tag}] step ${stepIndex}`,
    emit: (event, data) => emit(res, event, event === 'progress'
      ? { step: stepIndex, ...data }
      : { step: stepIndex, iteration: iterNum, ...data }),
  });
  if (takeWarnings.length) (prepResult.warnings ??= []).push(...takeWarnings);

  stepData.iterations.push({
    prompt:    prepResult.prompt,
    videoUrl,
    seed:      prepResult.params.seed,
    verdict:   'ACCEPT',
    diagnosis: 'video step (no review)',
    ...(prepResult.warnings?.length ? { warnings: [...prepResult.warnings] } : {}),
  });
  stepData.selectedIteration = null;
  stepData.outputVideoUrl = stepOutput(stepData)?.videoUrl ?? null;
  db.saveSession(session);

  return { accepted: true, outputVideoUrl: stepData.outputVideoUrl };
}

// ── Pipeline execution ────────────────────────────────────────────────────────────

async function runPipeline(session, pipelineDef, cfg, res, imageContext = [], opts = {}) {
  const tag = session.id.slice(0, 8);
  const startStep = opts.startStep ?? 0;
  const endStep   = opts.endStep ?? pipelineDef.length - 1;
  const abortController = new AbortController();
  const ctx = { userPrompt: session.prompt, references: session.references ?? [], imageContext, cfg, signal: abortController.signal };
  // Partial re-run: chain from the kept output of the step before startStep
  if (opts.initialInputImage) ctx.inputImage = opts.initialInputImage;

  // Iteration counts before this run — a kill must only discard work from this
  // run, not takes kept from earlier runs of the same step.
  const preRunCounts = session.steps.map(st => st.iterations.length);

  let killed = false;

  activeKills.set(session.id, async () => {
    killed = true;
    abortController.abort();
    await comfyui.interrupt();
    for (const [key, p] of pendingReviews) {
      if (key.startsWith(`${session.id}:`)) { pendingReviews.delete(key); p.reject(new Error('Stopped')); }
    }
    for (const [key, p] of pendingAcceptances) {
      if (key.startsWith(`${session.id}:`)) { clearTimeout(p.timer); pendingAcceptances.delete(key); p.resolve(false); }
    }
  });

  res.on('close', () => {
    for (const [key, p] of pendingReviews) {
      if (key.startsWith(`${session.id}:`)) { pendingReviews.delete(key); p.reject(new Error('Client disconnected')); }
    }
    for (const [key, p] of pendingAcceptances) {
      if (key.startsWith(`${session.id}:`)) { clearTimeout(p.timer); pendingAcceptances.delete(key); p.resolve(false); }
    }
  });

  let currentStep = startStep;
  try {
    let overallAccepted = false;

    for (let si = startStep; si <= endStep; si++) {
      currentStep = si;
      const stepDef = pipelineDef[si];

      // Ad-hoc steps can name the step whose output they build on.
      if (stepDef.inputFrom != null) {
        const src = stepOutput(session.steps[stepDef.inputFrom])?.imageUrl;
        if (!src) throw new Error(`Step ${stepDef.inputFrom + 1} has no output image for step ${si + 1} to build on`);
        ctx.inputImage = src;
      }

      let result;
      if (stepDef.type === 'video') {
        result = await runVideoStep(stepDef, si, session, { ...ctx }, cfg, res, () => killed);
      } else if (stepDef.type === 'generate') {
        result = await runGenerateStep(stepDef, si, session, { ...ctx }, cfg, res, () => killed);
      } else {
        result = await runUpscaleStep(stepDef, si, session, { ...ctx }, cfg, res, () => killed);
      }

      const { accepted, outputImageUrl, outputVideoUrl } = result;
      overallAccepted = accepted;

      // selectedIteration rides along so the client drops any stale manual pick
      // (a fresh run of a step supersedes it — see _runIterativeLoop / runVideoStep).
      const selectedIteration = session.steps[si]?.selectedIteration ?? null;
      if (outputImageUrl) {
        ctx.inputImage = outputImageUrl;
        emit(res, 'step_complete', { step: si, imageUrl: outputImageUrl, accepted, selectedIteration });
      } else if (outputVideoUrl) {
        emit(res, 'step_complete', { step: si, videoUrl: outputVideoUrl, accepted, selectedIteration });
      }

      // Don't run subsequent steps on a rejected output
      if (!accepted && si < endStep) break;
    }

    session.status = 'complete';
    console.log(`[${tag}] done — ${overallAccepted ? 'ACCEPTED' : 'max iterations reached'}`);
    const lastStep = session.steps[endStep];
    emit(res, 'done', {
      accepted:   overallAccepted,
      imageUrl:   lastStep?.outputImageUrl ?? null,
      videoUrl:   lastStep?.outputVideoUrl ?? null,
      sessionId:  session.id,
      prompt:     session.prompt,
      iterations: session.steps.reduce((sum, st) => sum + st.iterations.length, 0),
    });
  } catch (err) {
    if (killed) {
      // Discard partial data from the interrupted step so the session reflects
      // only finished work — but keep iterations from earlier runs of that step.
      const st = session.steps[currentStep];
      if (st) {
        st.iterations.length = preRunCounts[currentStep] ?? 0;
        // The surviving iterations are exactly the pre-run set, so a manual
        // selection among them is still valid — only drop it if it now dangles.
        if (st.selectedIteration != null && st.selectedIteration > st.iterations.length) st.selectedIteration = null;
        const kept = stepOutput(st);
        st.outputImageUrl = kept?.imageUrl ?? null;
        st.outputVideoUrl = kept?.videoUrl ?? null;
      }
      session.status = 'stopped';
      console.log(`[${tag}] stopped by user at step ${currentStep}`);
      emit(res, 'stopped', {
        step: currentStep,
        keptIterations:    st?.iterations.length ?? 0,
        selectedIteration: st?.selectedIteration ?? null,
      });
    } else {
      session.status = 'error';
      console.error(`[${tag}] error: ${err.message}`);
      emit(res, 'error', { message: err.message });
    }
  } finally {
    activeKills.delete(session.id);
    db.saveSession(session);
    res.end();
    // Refresh skill for each unique model used in generate steps (skipped when disabled globally)
    if (cfg.skillRefinement !== false) {
      const seenModelIds = new Set();
      for (const step of pipelineDef) {
        if (step.type !== 'generate' || !step.modelId || seenModelIds.has(step.modelId)) continue;
        seenModelIds.add(step.modelId);
        const mc = cfg.models?.[step.modelId];
        if (mc) {
          refreshSkill(mc.id, mc.label, mc.architecture)
            .catch(err => console.error(`[${tag}] skill refresh failed: ${err.message}`));
        }
      }
    }
  }
}

// ── Route helpers ─────────────────────────────────────────────────────────────────

// Split request overrides into generation params and per-step review config.
function splitOverrides(overrides = {}) {
  const { maxIterations, humanReview, acceptanceGracePeriod, ...genParams } = overrides;
  const review = {};
  if (maxIterations         !== undefined) review.maxIterations = maxIterations;
  if (humanReview           !== undefined) review.humanReview   = !!humanReview;
  if (acceptanceGracePeriod !== undefined) review.gracePeriod   = Number(acceptanceGracePeriod);
  return { genParams, review };
}

// Build pipelineDef from a workflow's steps, merging in per-request overrides.
function buildPipelineFromWorkflow(workflow, genParams, review) {
  return workflow.steps.map(stepDef => {
    const merged = { ...stepDef };
    if (Object.keys(genParams).length) merged.params = { ...(stepDef.params ?? {}), ...genParams };
    if (Object.keys(review).length)    merged.review = { ...(stepDef.review ?? {}), ...review };
    return merged;
  });
}

// A session's pipeline = the current workflow definition (so parameter edits
// apply on re-run) followed by any ad-hoc steps added to this session in the
// UI (session.extraSteps — e.g. "make a video from this image"). Extra steps
// may carry `inputFrom` (a step index) to build on that step's output instead
// of the immediately preceding step's.
function sessionPipeline(session, workflow, genParams = {}, review = {}) {
  return [...buildPipelineFromWorkflow(workflow, genParams, review), ...(session.extraSteps ?? [])];
}

function buildSessionSteps(pipelineDef, cfg) {
  return pipelineDef.map(stepDef => ({
    type:           stepDef.type,
    label:          steps.get(stepDef.type).label(stepDef, cfg),
    modelId:        stepDef.modelId ?? null,
    iterations:     [],
    selectedIteration: null,
    outputImageUrl: null,
    outputVideoUrl: null,
  }));
}

// ── Routes ────────────────────────────────────────────────────────────────────────

// POST /api/generate — start a new session using the active workflow
router.post('/', async (req, res) => {
  const cfg = config.load();

  let workflow;
  try { workflow = config.activeWorkflow(); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured. Set it in Settings first.' });

  const { prompt, references, overrides = {} } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });

  const { genParams, review } = splitOverrides(overrides);
  const pipelineDef = buildPipelineFromWorkflow(workflow, genParams, review);

  const session = {
    id:            uuidv4(),
    prompt:        prompt.trim(),
    workflowId:    workflow.id,
    workflowLabel: workflow.label,
    references:    Array.isArray(references) ? references : [],
    steps:         buildSessionSteps(pipelineDef, cfg),
    status:        'running',
    createdAt:     new Date().toISOString(),
  };
  sessions.set(session.id, session);
  db.saveSession(session);

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Session-Id': session.id });
  res.flushHeaders();
  emit(res, 'session', { id: session.id, prompt: session.prompt });

  await runPipeline(session, pipelineDef, cfg, res);
});

// Shared by /continue (full re-run) and /rerun (partial re-run): validates the
// session against the current workflow, replays history for the client, then
// runs the pipeline over [fromStep, toStep].
async function resumeSession(req, res, { fromStep = 0, toStep = null } = {}) {
  const cfg = config.load();

  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured.' });

  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.steps?.length) return res.status(400).json({ error: 'Session has no steps.' });
  if (activeKills.has(session.id)) return res.status(409).json({ error: 'Session is already running' });

  const workflow = cfg.workflows?.[session.workflowId];
  if (!workflow) return res.status(400).json({ error: `Workflow "${session.workflowId}" not found.` });

  const { overrides = {} } = req.body;
  const { genParams, review } = splitOverrides(overrides);
  const pipelineDef = sessionPipeline(session, workflow, genParams, review);

  // The session's steps were built from this workflow — if it changed shape
  // since, step indexes no longer line up and a re-run would corrupt the session.
  if (pipelineDef.length !== session.steps.length) {
    return res.status(400).json({ error: `Workflow "${session.workflowId}" changed shape since this session ran (${pipelineDef.length} steps vs ${session.steps.length}) — start a new session.` });
  }
  const drifted = pipelineDef.findIndex((d, i) => d.type !== session.steps[i].type);
  if (drifted !== -1) {
    return res.status(400).json({ error: `Workflow "${session.workflowId}" changed shape since this session ran (step ${drifted + 1} is now ${pipelineDef[drifted].type}, was ${session.steps[drifted].type}) — start a new session.` });
  }
  // Same shape — refresh labels so an edited model name shows up on re-run.
  for (let i = 0; i < pipelineDef.length; i++) {
    session.steps[i].label = steps.get(pipelineDef[i].type).label(pipelineDef[i], cfg);
  }

  const last    = pipelineDef.length - 1;
  const endStep = toStep ?? last;
  if (!Number.isInteger(fromStep) || fromStep < 0 || fromStep > last) {
    return res.status(400).json({ error: `fromStep out of range (0–${last})` });
  }
  if (!Number.isInteger(endStep) || endStep < fromStep || endStep > last) {
    return res.status(400).json({ error: `toStep out of range (${fromStep}–${last})` });
  }

  let initialInputImage = null;
  const sourceStep = pipelineDef[fromStep].inputFrom ?? (fromStep > 0 ? fromStep - 1 : null);
  if (sourceStep != null) {
    initialInputImage = stepOutput(session.steps[sourceStep])?.imageUrl ?? null;
    if (!initialInputImage) {
      return res.status(400).json({ error: `Step ${sourceStep} has no output image to chain from — re-run it first.` });
    }
  }

  session.status = 'running';
  sessions.set(session.id, session);

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Session-Id': session.id });
  res.flushHeaders();
  emit(res, 'session', { id: session.id, resume: true });

  // Replay all steps' history so the client can reconstruct the UI
  for (let si = 0; si < session.steps.length; si++) {
    const st = session.steps[si];
    emit(res, 'step', { index: si, type: st.type, label: st.label, total: session.steps.length, steering: st.steering ?? null });
    for (let i = 0; i < st.iterations.length; i++) {
      emit(res, 'history', {
        step: si, ...st.iterations[i], iteration: i + 1,
        ...(st.selectedIteration === i + 1 ? { selected: true } : {}),
      });
    }
  }

  await runPipeline(session, pipelineDef, cfg, res, [], { startStep: fromStep, endStep, initialInputImage });
}

// POST /api/generate/continue/:id — resume an existing session (full re-run)
router.post('/continue/:id', (req, res) => resumeSession(req, res));

// POST /api/generate/rerun/:id — re-run part of a session: { fromStep, toStep? }.
// Earlier steps keep their outputs; fromStep === toStep redoes a single step.
router.post('/rerun/:id', (req, res) => {
  const { fromStep = 0, toStep = null } = req.body ?? {};
  return resumeSession(req, res, { fromStep, toStep });
});

// GET /api/generate/sessions — list all persisted sessions
router.get('/sessions', (req, res) => {
  res.json(db.listSessions().map(s => ({
    id:             s.id,
    prompt:         s.prompt,
    workflowLabel:  s.workflowLabel,
    status:         s.status,
    createdAt:      s.createdAt,
    updatedAt:      s.updatedAt,
    iterationCount: (s.steps ?? []).reduce((sum, st) => sum + (st.iterations ?? []).length, 0),
  })));
});

// GET /api/generate/sessions/:id — full session data
router.get('/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// DELETE /api/generate/sessions?status=running|error|all — bulk delete
router.delete('/sessions', (req, res) => {
  const { status } = req.query;
  if (!status) return res.status(400).json({ error: 'status query param required (running|error|all)' });
  const all   = db.listSessions(Number.MAX_SAFE_INTEGER);
  let deleted = 0;
  for (const s of all) {
    if (status === 'all' || s.status === status) {
      sessions.delete(s.id);
      db.deleteSession(s.id);
      deleted++;
    }
  }
  res.json({ deleted });
});

// DELETE /api/generate/sessions/:id — delete a persisted session
router.delete('/sessions/:id', (req, res) => {
  const { id } = req.params;
  sessions.delete(id);
  for (const [key, p] of pendingReviews) {
    if (key.startsWith(`${id}:`)) { pendingReviews.delete(key); p.reject(new Error('Session deleted')); }
  }
  db.deleteSession(id);
  res.status(204).end();
});

// POST /api/generate/run — full per-request control (also used by sdapi shim)
router.post('/run', async (req, res) => {
  const cfg = config.load();

  const { prompt, references, imageContext, overrides = {}, humanReview, acceptanceGracePeriod, workflowId } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });

  let workflow;
  if (workflowId) {
    workflow = cfg.workflows?.[workflowId];
    if (!workflow) return res.status(400).json({ error: `Workflow "${workflowId}" not found` });
  } else {
    try { workflow = config.activeWorkflow(); }
    catch (err) { return res.status(400).json({ error: err.message }); }
  }

  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured. Set it in Settings first.' });

  const { genParams, review: baseReview } = splitOverrides(overrides);
  const review = { ...baseReview };
  if (humanReview           !== undefined) review.humanReview = !!humanReview;
  if (acceptanceGracePeriod !== undefined) review.gracePeriod = Number(acceptanceGracePeriod);

  const pipelineDef = buildPipelineFromWorkflow(workflow, genParams, review);

  const session = {
    id:            uuidv4(),
    prompt:        prompt.trim(),
    workflowId:    workflow.id,
    workflowLabel: workflow.label,
    references:    Array.isArray(references) ? references : [],
    steps:         buildSessionSteps(pipelineDef, cfg),
    status:        'running',
    createdAt:     new Date().toISOString(),
  };
  sessions.set(session.id, session);
  db.saveSession(session);

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Session-Id': session.id });
  res.flushHeaders();
  emit(res, 'session', { id: session.id, prompt: session.prompt });

  await runPipeline(session, pipelineDef, cfg, res, Array.isArray(imageContext) ? imageContext : []);
});

// POST /api/generate/human-review/:sessionId
router.post('/human-review/:sessionId', (req, res) => {
  const { stepIndex = 0, accept, feedback = '' } = req.body;
  const key     = `${req.params.sessionId}:${stepIndex}`;
  const pending = pendingReviews.get(key);
  if (!pending) return res.status(404).json({ error: 'No pending review for this session/step' });
  pendingReviews.delete(key);
  pending.resolve({ accept: !!accept, feedback: feedback.trim() });
  res.status(204).end();
});

// POST /api/generate/sessions/:id/select — pick which iteration (variant) of a
// step feeds downstream steps on the next partial re-run. Body: { stepIndex, iteration }.
router.post('/sessions/:id/select', (req, res) => {
  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (activeKills.has(req.params.id)) return res.status(409).json({ error: 'Session is running — wait for it to finish' });

  const { stepIndex, iteration } = req.body ?? {};
  const st = session.steps?.[stepIndex];
  if (!st) return res.status(400).json({ error: `No step ${stepIndex} in this session` });
  if (!Number.isInteger(iteration) || iteration < 1 || iteration > st.iterations.length) {
    return res.status(400).json({ error: `iteration out of range (1–${st.iterations.length})` });
  }

  st.selectedIteration = iteration;
  const sel = stepOutput(st);
  st.outputImageUrl = sel?.imageUrl ?? null;
  st.outputVideoUrl = sel?.videoUrl ?? null;
  sessions.set(session.id, session);
  db.saveSession(session);

  res.json({ stepIndex, selectedIteration: st.selectedIteration, outputImageUrl: st.outputImageUrl, outputVideoUrl: st.outputVideoUrl });
});

// POST /api/generate/sessions/:id/refuse-accepted
// POST /api/generate/sessions/:id/steps — append an ad-hoc step to a session,
// e.g. "make a video from this image" on a session whose workflow has no video
// step (an API-driven generate, say). Body:
//   { type: 'video', modelId, params?, inputFrom, iteration?, steering? }
// `inputFrom` is the step whose output the video animates; `iteration` (1-based)
// optionally picks that step's variant first; `steering` seeds the new step's
// notes (see PUT /sessions/:id/steps/:index/steering). Returns { stepIndex } —
// run it with POST /rerun/:id { fromStep: stepIndex }.
router.post('/sessions/:id/steps', (req, res) => {
  const cfg     = config.load();
  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (activeKills.has(req.params.id)) return res.status(409).json({ error: 'Session is running — wait for it to finish' });

  const { type = 'video', modelId, params = {}, inputFrom, iteration, steering } = req.body ?? {};
  if (type !== 'video') return res.status(400).json({ error: 'Only video steps can be added to an existing session' });
  const model = cfg.models?.[modelId];
  if (!model) return res.status(400).json({ error: `Model "${modelId}" not found in config` });
  if (!archMeta[model.architecture]?.videoArch) return res.status(400).json({ error: `"${model.label ?? modelId}" is not a video model` });

  const src = Number.isInteger(inputFrom) ? session.steps?.[inputFrom] : null;
  if (!src) return res.status(400).json({ error: `No step ${inputFrom} in this session` });
  if (iteration != null) {
    if (!Number.isInteger(iteration) || iteration < 1 || iteration > src.iterations.length) {
      return res.status(400).json({ error: `iteration out of range (1–${src.iterations.length})` });
    }
    src.selectedIteration = iteration;
    src.outputImageUrl = stepOutput(src)?.imageUrl ?? null;
    src.outputVideoUrl = stepOutput(src)?.videoUrl ?? null;
  }
  if (!stepOutput(src)?.imageUrl) return res.status(400).json({ error: `Step ${inputFrom + 1} has no output image to build a video from` });

  const stepDef = { type: 'video', modelId, params: params && typeof params === 'object' ? params : {}, inputFrom };
  session.extraSteps = [...(session.extraSteps ?? []), stepDef];
  session.steps.push(...buildSessionSteps([stepDef], cfg));
  if (typeof steering === 'string' && steering.trim()) session.steps.at(-1).steering = steering.trim().slice(0, 4000);
  sessions.set(session.id, session);
  db.saveSession(session);

  res.json({ stepIndex: session.steps.length - 1 });
});

// PUT /api/generate/sessions/:id/steps/:index/steering { steering } — director's
// notes for a video step's next take (framing, camera, pacing, sound). They are
// a reaction to what the earlier steps produced, so they live on the session,
// not the workflow. Empty clears them. Allowed while running: applies to the
// next take.
router.put('/sessions/:id/steps/:index/steering', (req, res) => {
  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const index = Number(req.params.index);
  const st = session.steps?.[index];
  if (!st) return res.status(400).json({ error: `No step ${req.params.index} in this session` });
  if (st.type !== 'video') return res.status(400).json({ error: 'Steering notes apply to video steps only' });
  const { steering } = req.body ?? {};
  if (steering != null && typeof steering !== 'string') return res.status(400).json({ error: 'steering must be a string' });
  const text = (steering ?? '').trim().slice(0, 4000);
  if (text) st.steering = text; else delete st.steering;
  sessions.set(session.id, session);
  db.saveSession(session, { touch: false });
  res.json({ stepIndex: index, steering: st.steering ?? null });
});

router.post('/sessions/:id/refuse-accepted', (req, res) => {
  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const { stepIndex, iterationN } = req.body ?? {};
  let found = null;
  let foundStepIndex = -1;

  if (Number.isInteger(stepIndex) && Number.isInteger(iterationN)) {
    // Explicit target from the client
    const it = session.steps?.[stepIndex]?.iterations?.[iterationN - 1];
    if (it?.verdict === 'ACCEPT') { found = it; foundStepIndex = stepIndex; }
  } else {
    // Legacy: last accepted iteration anywhere in the session
    for (let si = session.steps.length - 1; si >= 0 && !found; si--) {
      const it = [...session.steps[si].iterations].reverse().find(it => it.verdict === 'ACCEPT');
      if (it) { found = it; foundStepIndex = si; }
    }
  }

  if (!found) return res.status(400).json({ error: 'No accepted iteration to refuse' });

  found.verdict = 'REFUSED';
  db.saveSession(session);

  const pendingAcc = pendingAcceptances.get(`${req.params.id}:${foundStepIndex}`);
  if (pendingAcc) {
    clearTimeout(pendingAcc.timer);
    pendingAcceptances.delete(`${req.params.id}:${foundStepIndex}`);
    pendingAcc.resolve(true);
  }

  res.status(204).end();
});

// GET /api/generate/events — broadcast SSE stream
router.post('/kill', async (req, res) => {
  const { sessionId } = req.body;
  const kill = activeKills.get(sessionId);
  if (!kill) return res.status(404).json({ error: 'No active generation for this session' });
  await kill();
  res.json({ ok: true });
});

router.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.flushHeaders();

  const onEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  genEmitter.on('gen', onEvent);
  req.on('close', () => genEmitter.off('gen', onEvent));
});

module.exports = router;

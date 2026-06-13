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
const { refreshSkill } = require('../services/skillRefresher');
const steps   = require('../steps');
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
  const review      = stepDef.review ?? {};
  const maxNewIter  = review.maxIterations ?? cfg.maxIterations ?? 4;
  const humanReview = review.humanReview   ?? cfg.humanReview   ?? false;
  const gracePeriod = cfg.bypassGracePeriod ? 0
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

      const workflow = stepType.buildComfyWorkflow(stepDef, prepResult, ctx);
      const { images } = await comfyui.generate(
        workflow,
        pct => {
          emit(res, 'progress', { step: stepIndex, iteration: iterNum, pct });
          process.stdout.write(`\r[${tag}] step ${stepIndex} iter ${iterNum}: generating ${pct}%   `);
        },
        previewUrl => emit(res, 'preview', { step: stepIndex, iteration: iterNum, url: previewUrl }),
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
      if (stepType.skipReview?.(stepDef)) {
        verdict   = 'ACCEPT';
        diagnosis = 'deterministic step — review skipped';
        console.log(`[${tag}] step ${stepIndex} iter ${iterNum}: review skipped (deterministic step)`);
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
        skills.record(session.workflowId, session.workflowLabel, ctx.modelConfig?.architecture, accepted ? 'ACCEPT' : 'REJECT');
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

  const lastIter = stepData.iterations[stepData.iterations.length - 1];
  stepData.outputImageUrl = lastIter?.imageUrl ?? null;
  return { accepted, outputImageUrl: stepData.outputImageUrl };
}

async function runGenerateStep(stepDef, stepIndex, session, ctx, cfg, res, isKilled = () => false) {
  const modelConfig = cfg.models?.[stepDef.modelId];
  if (!modelConfig) throw new Error(`Model "${stepDef.modelId}" not found in config`);
  ctx = { ...ctx, modelConfig, skillId: session.workflowId };

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
  ctx = { ...ctx, modelConfig };

  emit(res, 'step', { index: stepIndex, type: 'video', label: stepData.label, total: session.steps.length });
  console.log(`[${tag}] step ${stepIndex} (video: ${stepData.label})`);

  if (isKilled()) throw new Error('Generation stopped by user');

  emit(res, 'phase', { step: stepIndex, phase: 'generating', iteration: 1 });
  console.log(`[${tag}] step ${stepIndex}: preparing video…`);

  const prepResult = await stepType.prepare(stepDef, ctx);

  if (isKilled()) throw new Error('Generation stopped by user');

  console.log(`[${tag}] step ${stepIndex}: queuing video ComfyUI job…`);
  const workflow = stepType.buildComfyWorkflow(stepDef, prepResult, ctx);

  const { videos } = await comfyui.generateVideo(
    workflow,
    pct => {
      emit(res, 'progress', { step: stepIndex, pct });
      process.stdout.write(`\r[${tag}] step ${stepIndex}: generating ${pct}%   `);
    },
  );
  process.stdout.write('\n');

  if (isKilled()) throw new Error('Generation stopped by user');
  if (!videos.length) throw new Error('ComfyUI returned no video output');

  const vid      = videos[0];
  const videoUrl = `/api/video?filename=${encodeURIComponent(vid.filename)}&subfolder=${encodeURIComponent(vid.subfolder ?? '')}&type=${encodeURIComponent(vid.type ?? 'output')}`;
  console.log(`[${tag}] step ${stepIndex}: video ready — ${vid.filename}`);

  emit(res, 'video', { step: stepIndex, url: videoUrl });
  stepData.outputVideoUrl = videoUrl;
  db.saveSession(session);

  return { accepted: true, outputVideoUrl: videoUrl };
}

// ── Pipeline execution ────────────────────────────────────────────────────────────

async function runPipeline(session, pipelineDef, cfg, res, imageContext = []) {
  const tag = session.id.slice(0, 8);
  const abortController = new AbortController();
  const ctx = { userPrompt: session.prompt, references: session.references ?? [], imageContext, cfg, signal: abortController.signal };

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

  let currentStep = 0;
  try {
    let overallAccepted = false;

    for (let si = 0; si < pipelineDef.length; si++) {
      currentStep = si;
      const stepDef = pipelineDef[si];

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

      if (outputImageUrl) {
        ctx.inputImage = outputImageUrl;
        emit(res, 'step_complete', { step: si, imageUrl: outputImageUrl, accepted });
      } else if (outputVideoUrl) {
        emit(res, 'step_complete', { step: si, videoUrl: outputVideoUrl, accepted });
      }

      // Don't run subsequent steps on a rejected output
      if (!accepted && si < pipelineDef.length - 1) break;
    }

    session.status = 'complete';
    console.log(`[${tag}] done — ${overallAccepted ? 'ACCEPTED' : 'max iterations reached'}`);
    const lastStep = session.steps[session.steps.length - 1];
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
      // Clear partial data from the interrupted step so session reflects only finished work
      if (session.steps[currentStep]) {
        session.steps[currentStep].iterations    = [];
        session.steps[currentStep].outputImageUrl = null;
        session.steps[currentStep].outputVideoUrl = null;
      }
      session.status = 'stopped';
      console.log(`[${tag}] stopped by user at step ${currentStep}`);
      emit(res, 'stopped', { step: currentStep });
    } else {
      session.status = 'error';
      console.error(`[${tag}] error: ${err.message}`);
      emit(res, 'error', { message: err.message });
    }
  } finally {
    activeKills.delete(session.id);
    db.saveSession(session);
    res.end();
    // Refresh skill for this workflow using the first generate step's model arch
    if (session.workflowId) {
      const workflow = cfg.workflows?.[session.workflowId];
      if (workflow) {
        const firstGenStep = pipelineDef.find(s => s.type === 'generate');
        const modelConfig  = firstGenStep ? cfg.models?.[firstGenStep.modelId] : null;
        if (modelConfig) {
          refreshSkill(session.workflowId, workflow.label, modelConfig.architecture)
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

function buildSessionSteps(pipelineDef, cfg) {
  return pipelineDef.map(stepDef => ({
    type:           stepDef.type,
    label:          steps.get(stepDef.type).label(stepDef, cfg),
    modelId:        stepDef.modelId ?? null,
    iterations:     [],
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

// POST /api/generate/continue/:id — resume an existing session
router.post('/continue/:id', async (req, res) => {
  const cfg = config.load();

  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured.' });

  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.steps?.length) return res.status(400).json({ error: 'Session has no steps.' });

  const workflow = cfg.workflows?.[session.workflowId];
  if (!workflow) return res.status(400).json({ error: `Workflow "${session.workflowId}" not found.` });

  session.status = 'running';
  sessions.set(session.id, session);

  const { overrides = {} } = req.body;
  const { genParams, review } = splitOverrides(overrides);
  const pipelineDef = buildPipelineFromWorkflow(workflow, genParams, review);

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Session-Id': session.id });
  res.flushHeaders();
  emit(res, 'session', { id: session.id, resume: true });

  // Replay all steps' history so the client can reconstruct the UI
  for (let si = 0; si < session.steps.length; si++) {
    const st = session.steps[si];
    emit(res, 'step', { index: si, type: st.type, label: st.label, total: session.steps.length });
    for (let i = 0; i < st.iterations.length; i++) {
      emit(res, 'history', { step: si, ...st.iterations[i], iteration: i + 1 });
    }
  }

  await runPipeline(session, pipelineDef, cfg, res);
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

// POST /api/generate/sessions/:id/refuse-accepted
router.post('/sessions/:id/refuse-accepted', (req, res) => {
  const session = sessions.get(req.params.id) ?? db.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  let found = null;
  let foundStepIndex = -1;
  for (let si = session.steps.length - 1; si >= 0 && !found; si--) {
    const it = [...session.steps[si].iterations].reverse().find(it => it.verdict === 'ACCEPT');
    if (it) { found = it; foundStepIndex = si; }
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

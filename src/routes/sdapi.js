'use strict';

// Partial emulation of the Automatic1111 / stable-diffusion-webui REST API.
// Mounted at /sdapi/v1 in server.js.
//
// Implemented:
//   POST /sdapi/v1/txt2img              — blocking generation (runs the full iteration loop)
//   POST /sdapi/v1/img2img              — generation with reference images; init_images are:
//                                         • always passed as LLM vision context (prompt builder sees them)
//                                         • uploaded to ComfyUI and used as diffusion references only when
//                                           the active workflow step is configured for "adapter" or "init-image" mode
//                                         denoising_strength maps to the denoise param for init-image mode
//   GET  /sdapi/v1/progress             — progress polling during a running generation request
//   POST /sdapi/v1/interrupt            — abort a running request
//   GET  /sdapi/v1/sd-models            — list configured models
//   GET  /sdapi/v1/options              — get active model
//   POST /sdapi/v1/options              — set active model via sd_model_checkpoint
//   GET  /sdapi/v1/samplers             — list supported samplers
//   GET  /sdapi/v1/schedulers           — list supported schedulers
//   GET  /sdapi/v1/upscalers            — stub (no upscaling support)
//   GET  /sdapi/v1/latent-upscale-modes — stub (no latent upscaling support)
//   GET  /sdapi/v1/sd-vae               — stub (no VAE switching support)

const express  = require('express');
const router   = express.Router();
const sharp    = require('sharp');
const config   = require('../services/config');
const comfyui  = require('../services/comfyui');
const queue    = require('../services/queue');

async function padToSquare(buffer) {
  const { width, height } = await sharp(buffer).metadata();
  if (width === height) return buffer;
  const size = Math.max(width, height);
  const left = Math.floor((size - width)  / 2);
  const top  = Math.floor((size - height) / 2);
  return sharp(buffer)
    .extend({ top, bottom: size - height - top, left, right: size - width - left,
              background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .toBuffer();
}

// ── Progress state (module-level; one active job at a time) ──────────────────

const jobState = {
  active:    false,
  sessionId: null,
  iteration: 0,
  phase:     '',
  progress:  0,
};

// ── Sampler name mapping (A1111 display name → our internal names) ────────────
// Any name not in this map (including "Automatic" and empty strings) leaves the
// sampler override unset so the model's workflow default is used instead.

const SAMPLER_MAP = {
  'euler':                 { sampler: 'euler' },
  'euler a':               { sampler: 'euler_ancestral' },
  'euler ancestral':       { sampler: 'euler_ancestral' },
  'heun':                  { sampler: 'heun' },
  'lms':                   { sampler: 'lms' },
  'dpm2':                  { sampler: 'dpm_2' },
  'dpm2 a':                { sampler: 'dpm_2_ancestral' },
  'dpm++ sde':             { sampler: 'dpmpp_sde' },
  'dpm++ sde karras':      { sampler: 'dpmpp_sde',      scheduler: 'karras' },
  'dpm++ 2m':              { sampler: 'dpmpp_2m' },
  'dpm++ 2m karras':       { sampler: 'dpmpp_2m',       scheduler: 'karras' },
  'dpm++ 2m sde':          { sampler: 'dpmpp_2m_sde' },
  'dpm++ 2m sde karras':   { sampler: 'dpmpp_2m_sde',   scheduler: 'karras' },
  'dpm++ 3m sde':          { sampler: 'dpmpp_3m_sde' },
  'dpm++ 3m sde karras':   { sampler: 'dpmpp_3m_sde',   scheduler: 'karras' },
  'ddim':                  { sampler: 'ddim' },
  'unipc':                 { sampler: 'uni_pc' },
  'uni pc':                { sampler: 'uni_pc' },
  'er sde':                { sampler: 'er_sde' },
  'er_sde':                { sampler: 'er_sde' },
};

const SAMPLERS_LIST = [
  { name: 'Automatic',            aliases: [],                       options: {} },
  { name: 'Euler',                aliases: ['euler'],                options: {} },
  { name: 'Euler a',              aliases: ['euler_a'],              options: {} },
  { name: 'Heun',                 aliases: ['heun'],                 options: {} },
  { name: 'LMS',                  aliases: ['lms'],                  options: {} },
  { name: 'DPM2',                 aliases: ['dpm_2'],                options: {} },
  { name: 'DPM2 a',              aliases: ['dpm_2_ancestral'],      options: {} },
  { name: 'DPM++ SDE',           aliases: ['dpmpp_sde'],            options: {} },
  { name: 'DPM++ SDE Karras',    aliases: ['dpmpp_sde_karras'],     options: {} },
  { name: 'DPM++ 2M',            aliases: ['dpmpp_2m'],             options: {} },
  { name: 'DPM++ 2M Karras',     aliases: ['dpmpp_2m_karras'],      options: {} },
  { name: 'DPM++ 2M SDE',        aliases: ['dpmpp_2m_sde'],         options: {} },
  { name: 'DPM++ 2M SDE Karras', aliases: ['dpmpp_2m_sde_karras'],  options: {} },
  { name: 'DPM++ 3M SDE',        aliases: ['dpmpp_3m_sde'],         options: {} },
  { name: 'DPM++ 3M SDE Karras', aliases: ['dpmpp_3m_sde_karras'],  options: {} },
  { name: 'DDIM',                 aliases: ['ddim'],                 options: {} },
  { name: 'UniPC',                aliases: ['uni_pc'],               options: {} },
  { name: 'ER SDE',               aliases: ['er_sde'],               options: {} },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function modelToA1111(id, m) {
  return {
    title:      `${m.label} [${id}]`,
    model_name: m.label,
    hash:       null,
    sha256:     null,
    filename:   m.unetName || m.checkpoint || '',
    config:     null,
  };
}

// Find a model ID by A1111 title ("Label [id]"), bare id, or label (case-insensitive).
function findModelId(cfg, sdModelCheckpoint) {
  if (!sdModelCheckpoint) return null;
  const s = sdModelCheckpoint.toLowerCase().trim();
  for (const [id, m] of Object.entries(cfg.models || {})) {
    if (id.toLowerCase() === s)                            return id;
    if ((m.label ?? '').toLowerCase() === s)               return id;
    if (`${m.label} [${id}]`.toLowerCase() === s)          return id;
  }
  return null;
}

// Find the first workflow whose first generate step uses this model.
function findWorkflowForModel(cfg, modelId) {
  if (!modelId) return null;
  for (const [id, workflow] of Object.entries(cfg.workflows || {})) {
    const firstGen = (workflow.steps ?? []).find(s => s.type === 'generate');
    if (firstGen?.modelId === modelId) return id;
  }
  return null;
}

// Read an SSE fetch response stream, calling onEvent for each parsed event.
// Returns a Promise that resolves when the stream ends.
async function consumeSSE(response, onEvent) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const eMatch = block.match(/^event: (.+)$/m);
      const dMatch = block.match(/^data: (.+)$/m);
      if (!eMatch || !dMatch) continue;
      try { onEvent(eMatch[1].trim(), JSON.parse(dMatch[1])); } catch { /* ignore */ }
    }
  }
}

// Fetch a server-relative image path and return a base64-encoded string.
async function fetchBase64(host, imageUrl) {
  const res = await fetch(`http://${host}${imageUrl}`);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ── Shared generation handler (used by both txt2img and img2img) ─────────────

async function handleGenerationRequest(req, res) {
  const cfg = config.load();
  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured.' });

  const {
    prompt            = '',
    negative_prompt   = '',
    init_images       = [],
    denoising_strength,
    steps,
    cfg_scale,
    width,
    height,
    sampler_name,
    scheduler,
    seed              = -1,
    batch_size        = 1,
    n_iter            = 1,
    override_settings = {},
  } = req.body;

  if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });

  let modelId;
  if (override_settings.sd_model_checkpoint) {
    modelId = findModelId(cfg, override_settings.sd_model_checkpoint);
  }

  const workflowId = (modelId && findWorkflowForModel(cfg, modelId)) || cfg.activeWorkflow;
  if (!workflowId || !cfg.workflows?.[workflowId]) {
    return res.status(400).json({ error: 'No active workflow configured.' });
  }

  if (!modelId) {
    const firstGen = (cfg.workflows[workflowId].steps ?? []).find(s => s.type === 'generate');
    modelId = firstGen?.modelId ?? null;
  }

  if (modelId && !cfg.models?.[modelId]) {
    return res.status(400).json({ error: `Model "${modelId}" not found in config.` });
  }

  const overrides = {};
  if (negative_prompt)  overrides.negativePrompt = negative_prompt;
  if (steps    != null) overrides.steps    = Number(steps);
  if (width    != null) overrides.width    = Number(width);
  if (height   != null) overrides.height   = Number(height);
  if (cfg_scale != null) { overrides.guidance = Number(cfg_scale); overrides.cfgScale = Number(cfg_scale); }

  if (sampler_name) {
    const mapped = SAMPLER_MAP[sampler_name.toLowerCase()];
    if (mapped) {
      overrides.sampler = mapped.sampler;
      if (mapped.scheduler) overrides.scheduler = mapped.scheduler;
    }
  }

  if (scheduler && scheduler !== 'N/A') {
    overrides.scheduler = scheduler.toLowerCase().replace(/\s+/g, '_');
  }

  const rawImages    = init_images.map(b64 => b64.replace(/^data:image\/\w+;base64,/, ''));
  const imageContext = rawImages;

  let references = [];
  if (rawImages.length) {
    const wf       = cfg.workflows?.[workflowId];
    const firstGen = (wf?.steps ?? []).find(s => s.type === 'generate');
    const diffMode = firstGen?.referenceStrategy?.diffusion?.mode;
    if (diffMode === 'adapter' || diffMode === 'init-image') {
      references = await Promise.all(rawImages.map(async (raw, i) => {
        const buf = await padToSquare(Buffer.from(raw, 'base64'));
        return comfyui.uploadImage(buf, `sdapi_ref_${i}.png`);
      }));
      if (denoising_strength != null && diffMode === 'init-image') {
        overrides.denoise = Number(denoising_strength);
      }
    }
  }

  const host  = req.headers.host;
  const total = Math.max(1, Number(batch_size)) * Math.max(1, Number(n_iter));

  const clientAC = new AbortController();

  // Mark jobState active for /progress polling (shows 'Queued' until the job runs)
  jobState.active    = true;
  jobState.progress  = 0;
  jobState.phase     = 'Queued…';
  jobState.iteration = 0;
  jobState.sessionId = null;

  res.on('close', () => { if (!res.writableEnded) clientAC.abort(); });

  // Keep the connection alive for clients/proxies with idle-read timeouts.
  // Spaces are valid JSON leading whitespace; the real payload comes at the end.
  // Delay the first write by 60 s so early validation errors still return proper HTTP status codes.
  let keepaliveInterval = null;
  const keepaliveStart = setTimeout(() => {
    if (!res.writableEnded) {
      res.setHeader('Content-Type', 'application/json');
      res.write(' ');
      keepaliveInterval = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 30_000);
    }
  }, 60_000);
  const clearKeepalive = () => { clearTimeout(keepaliveStart); clearInterval(keepaliveInterval); };

  let result;
  try {
    result = await queue.enqueue({
      prompt:     prompt.slice(0, 120),
      workflowId,
      refCount:   references.length,
      signal:     clientAC.signal,
      runFn: async (pipelineSignal) => {
        const images = [];
        const seeds  = [];
        let   lastImageUrl = null;

        // When the pipeline signal fires, kill the server-side pipeline
        pipelineSignal.addEventListener('abort', () => {
          const sid = jobState.sessionId;
          if (sid) {
            fetch(`http://${host}/api/generate/kill`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: sid }),
            }).catch(() => {});
          }
        }, { once: true });

        for (let i = 0; i < total; i++) {
          const iterSeed      = seed !== -1 ? Number(seed) + i : undefined;
          const iterOverrides = iterSeed != null ? { ...overrides, seed: iterSeed } : overrides;

          const runRes = await fetch(`http://${host}/api/generate/run`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body:   JSON.stringify({ prompt, references, imageContext, overrides: iterOverrides, workflowId }),
            signal: pipelineSignal,
          });

          if (!runRes.ok) {
            const body = await runRes.json().catch(() => ({}));
            throw new Error(body.error || `Run request failed with status ${runRes.status}`);
          }

          let resolveRun, rejectRun;
          const runPromise = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });

          consumeSSE(runRes, (event, data) => {
            switch (event) {
              case 'session':  jobState.sessionId = data.id; break;
              case 'phase':    jobState.phase = data.phase; jobState.iteration = data.iteration ?? 0; break;
              case 'progress': jobState.progress = data.pct ?? 0; break;
              case 'done':     resolveRun(data); break;
              case 'error':    rejectRun(new Error(data.message)); break;
            }
          }).then(() => rejectRun(new Error('Generation stream ended without a result')))
            .catch(rejectRun);

          const runResult = await runPromise;

          if (runResult.imageUrl) {
            images.push(await fetchBase64(host, runResult.imageUrl));
            lastImageUrl = runResult.imageUrl;
          }
          seeds.push(iterSeed ?? -1);
        }

        return { images, seeds, outputImageUrl: lastImageUrl };
      },
    });
  } catch (err) {
    clearKeepalive();
    jobState.active = false; jobState.progress = 0; jobState.phase = ''; jobState.sessionId = null;
    if (!res.headersSent) return res.status(500).json({ error: err.message });
    if (!res.writableEnded) res.end(JSON.stringify({ error: err.message }));
    return;
  }

  clearKeepalive();
  jobState.active = false; jobState.progress = 0; jobState.phase = ''; jobState.sessionId = null;

  const { images, seeds } = result;
  const info = JSON.stringify({
    prompt, negative_prompt,
    seed:         seeds[0] ?? -1,
    all_seeds:    seeds,
    steps:        overrides.steps    ?? null,
    cfg_scale:    overrides.guidance ?? null,
    width:        overrides.width    ?? null,
    height:       overrides.height   ?? null,
    sampler_name: sampler_name       ?? null,
    model:        modelId,
    infotexts:    [`${prompt}\nNegative prompt: ${negative_prompt}`],
  });

  const payload = JSON.stringify({ images, parameters: req.body, info });
  if (res.headersSent) res.end(payload);
  else res.json({ images, parameters: req.body, info });
}

// ── POST /sdapi/v1/txt2img ────────────────────────────────────────────────────
router.post('/txt2img', handleGenerationRequest);

// ── POST /sdapi/v1/img2img ────────────────────────────────────────────────────
router.post('/img2img', handleGenerationRequest);

// ── GET /sdapi/v1/progress ────────────────────────────────────────────────────

router.get('/progress', (req, res) => {
  if (!jobState.active) {
    return res.json({
      progress:      0,
      eta_relative:  0,
      state:         { job: '', job_count: 0, job_no: 0, skipped: false, interrupted: false },
      current_image: null,
      textinfo:      '',
    });
  }
  res.json({
    progress:      Math.min(jobState.progress, 99) / 100,
    eta_relative:  0,
    state: {
      job:         jobState.phase,
      job_count:   1,
      job_no:      jobState.iteration,
      skipped:     false,
      interrupted: false,
    },
    current_image: null,
    textinfo:      `Iteration ${jobState.iteration}: ${jobState.phase}`,
  });
});

// ── GET /sdapi/v1/sd-models ───────────────────────────────────────────────────

router.get('/sd-models', (req, res) => {
  const cfg = config.load();
  res.json(Object.entries(cfg.models || {}).map(([id, m]) => modelToA1111(id, m)));
});

// ── GET|POST /sdapi/v1/options ────────────────────────────────────────────────

router.get('/options', (req, res) => {
  const cfg      = config.load();
  const wfId     = cfg.activeWorkflow;
  const workflow = wfId ? cfg.workflows?.[wfId] : null;
  const firstGen = (workflow?.steps ?? []).find(s => s.type === 'generate');
  const modelId  = firstGen?.modelId ?? null;
  const model    = modelId ? cfg.models?.[modelId] : null;
  res.json({
    sd_model_checkpoint: model ? `${model.label} [${modelId}]` : '',
    sd_model_hash:       '',
  });
});

router.post('/options', (req, res) => {
  const { sd_model_checkpoint } = req.body;
  if (sd_model_checkpoint) {
    const cfg = config.load();
    const modelId = findModelId(cfg, sd_model_checkpoint);
    if (!modelId) return res.status(400).json({ error: `Model "${sd_model_checkpoint}" not found` });
    // Switch to the first workflow that uses this model
    const workflowId = findWorkflowForModel(cfg, modelId);
    if (!workflowId) return res.status(400).json({ error: `No workflow found for model "${sd_model_checkpoint}"` });
    config.save({ activeWorkflow: workflowId });
  }
  res.json({});
});

// ── GET /sdapi/v1/samplers ────────────────────────────────────────────────────

router.get('/samplers', (req, res) => {
  res.json(SAMPLERS_LIST);
});

// ── GET /sdapi/v1/schedulers ──────────────────────────────────────────────────
// Returns ComfyUI scheduler names directly — these pass through to the workflow
// without translation.

router.get('/schedulers', (req, res) => {
  res.json([
    { name: 'normal' },
    { name: 'karras' },
    { name: 'exponential' },
    { name: 'sgm_uniform' },
    { name: 'simple' },
    { name: 'beta' },
    { name: 'ddim_uniform' },
  ]);
});

// ── GET /sdapi/v1/upscalers ───────────────────────────────────────────────────
// We don't support upscaling; return the minimum stub so SillyTavern's upscaler
// dropdown is populated with "None" instead of erroring.

router.get('/upscalers', (req, res) => {
  res.json([{ name: 'None' }]);
});

// ── GET /sdapi/v1/latent-upscale-modes ───────────────────────────────────────

router.get('/latent-upscale-modes', (req, res) => {
  res.json([]);
});

// ── GET /sdapi/v1/sd-vae ─────────────────────────────────────────────────────
// No VAE switching; return an empty list.

router.get('/sd-vae', (req, res) => {
  res.json([]);
});

// ── POST /sdapi/v1/interrupt ──────────────────────────────────────────────────
// Abort the currently-running txt2img job (if any).

router.post('/interrupt', (req, res) => {
  const { running } = queue.getState();
  if (running) queue.cancel(running.id);
  res.json({});
});

module.exports = router;

'use strict';

const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const config = require('./config');

const baseUrl = () => config.load().comfyuiUrl;
const wsUrl   = () => baseUrl().replace(/^http/, 'ws');

// ── Generation ─────────────────────────────────────────────────────────────

// opts.signal — AbortSignal; aborting rejects the wait with Error('Stopped')
// so a killed pipeline never sits on a ComfyUI job that will not report back.
async function generate(workflow, onProgress, onPreview, opts = {}) {
  const clientId = uuidv4();
  const promptId = await queuePrompt(workflow, clientId);
  await waitForCompletion(promptId, clientId, onProgress, onPreview, opts.signal);
  return getOutputImages(promptId);
}

async function queuePrompt(workflow, clientId) {
  const res = await fetch(`${baseUrl()}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!res.ok) throw new Error(`ComfyUI queue error ${res.status}: ${await res.text()}`);
  return (await res.json()).prompt_id;
}

function waitForCompletion(promptId, clientId, onProgress, onPreview, signal) {
  return new Promise((resolve, reject) => {
    let done        = false;
    let ws          = null;
    let reconnects  = 0;
    const MAX_RECONNECTS = 30;

    const onAbort = () => finish(new Error('Stopped'));

    const finish = (err) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      try { ws?.close(); } catch {}
      err ? reject(err) : resolve();
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    // Is the prompt still in ComfyUI's running/pending queue? A restarted server
    // comes back with an empty queue and no history entry for the job, so
    // without this check a reconnect would wait forever for a completion that
    // never comes. Returns true on network errors (can't tell — keep waiting).
    const isQueued = async () => {
      try {
        const res = await fetch(`${baseUrl()}/queue`);
        if (!res.ok) return true;
        const data = await res.json();
        const ids  = [...(data.queue_running ?? []), ...(data.queue_pending ?? [])].map(item => item?.[1]);
        return ids.includes(promptId);
      } catch {
        return true;
      }
    };

    // Poll /history to check whether the prompt completed while the WS was down.
    // Returns true (success), throws (execution_error), or returns false (still running).
    const checkHistory = async () => {
      try {
        const res   = await fetch(`${baseUrl()}/history/${promptId}`);
        if (!res.ok) return false;
        const data  = await res.json();
        const entry = data[promptId];
        if (!entry) return false;
        const status = entry.status;
        if (status?.status_str === 'error') {
          const msgs    = status.messages ?? [];
          const errData = msgs.find(([t]) => t === 'execution_error')?.[1];
          const nodeCtx = errData?.node_type ? ` [${errData.node_type}]` : '';
          const errMsg  = errData?.exception_message;
          throw new Error(`ComfyUI${nodeCtx}: ${errMsg || 'execution error'}`);
        }
        return status?.completed === true;
      } catch (e) {
        if (e.message.startsWith('ComfyUI:')) throw e;
        return false; // network hiccup — assume still running
      }
    };

    const handleMessage = (raw, isBinary) => {
      // Binary frame: 4-byte big-endian event type + image data (JPEG preview from ComfyUI)
      if (isBinary) {
        const frameType = raw.length > 4 ? raw.readUInt32BE(0) : -1;
        if (onPreview && raw.length > 4 && frameType === 1) {
          const img    = raw.slice(4);
          const isJpeg = img[0] === 0xFF && img[1] === 0xD8;
          console.log(`[comfyui] preview frame: ${img.length} bytes (${isJpeg ? 'jpeg' : 'png'})`);
          onPreview(`data:${isJpeg ? 'image/jpeg' : 'image/png'};base64,${img.toString('base64')}`);
        } else {
          console.log(`[comfyui] binary WS frame: ${raw.length} bytes, type=${frameType}`);
        }
        return;
      }
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'progress' && msg.data?.prompt_id === promptId) {
          onProgress?.(Math.round((msg.data.value / msg.data.max) * 100));
        }
        if (msg.type === 'executing' && msg.data?.prompt_id === promptId && msg.data.node === null) {
          finish();
        }
        // Interrupted via POST /interrupt — treat as clean stop, not an error.
        // Accept even when prompt_id is absent (older ComfyUI versions omit it).
        if (msg.type === 'execution_interrupted') {
          if (!msg.data?.prompt_id || msg.data.prompt_id === promptId) finish();
        }
        // ComfyUI execution error (e.g. OOM, missing model) — reject so the
        // pipeline surfaces the actual error rather than hanging or returning no images.
        if (msg.type === 'execution_error') {
          if (!msg.data?.prompt_id || msg.data.prompt_id === promptId) {
            const nodeCtx = msg.data?.node_type ? ` [${msg.data.node_type}]` : '';
            const detail  = msg.data?.exception_message || msg.data?.error || 'execution error';
            finish(new Error(`ComfyUI${nodeCtx}: ${detail}`));
          }
        }
      } catch { /* ignore parse errors */ }
    };

    const connect = () => {
      if (done) return;
      ws = new WebSocket(`${wsUrl()}/ws?clientId=${clientId}`);
      ws.on('open',    async ()    => {
        const wasReconnect = reconnects > 0;
        reconnects = 0;
        if (!wasReconnect || done) return;
        // Back online after a drop: make sure ComfyUI still has the job. Queue
        // first, then history — a job that just left the queue is in history.
        try {
          if (await isQueued()) return;
          if (await checkHistory()) return finish();
          finish(new Error('ComfyUI lost the job (server restarted?) — re-run the step'));
        } catch (e) { finish(e); }
      });
      ws.on('message', handleMessage);
      // Log WS errors but don't finish — the 'close' event fires after 'error' and
      // handles the reconnect/fail decision there.
      ws.on('error',   (err)       => console.error(`[comfyui] WS error: ${err.message}`));
      ws.on('close',   async ()    => {
        if (done) return;
        // Check whether generation completed while we were disconnected
        try {
          if (await checkHistory()) { finish(); return; }
        } catch (e) { finish(e); return; }
        // Still running — reconnect with linear backoff capped at 30 s
        reconnects++;
        if (reconnects > MAX_RECONNECTS) {
          finish(new Error(`ComfyUI WebSocket disconnected after ${MAX_RECONNECTS} reconnect attempts`));
          return;
        }
        const delay = Math.min(2000 * reconnects, 30_000);
        console.log(`[comfyui] WS disconnected, reconnecting in ${delay / 1000}s (attempt ${reconnects}/${MAX_RECONNECTS})...`);
        setTimeout(connect, delay);
      });
    };

    connect();
  });
}

async function getOutputImages(promptId) {
  const res = await fetch(`${baseUrl()}/history/${promptId}`);
  if (!res.ok) throw new Error(`ComfyUI history error ${res.status}`);
  const data = await res.json();
  const entry = data[promptId];
  if (!entry) throw new Error('No history entry for prompt');
  const images = [];
  for (const out of Object.values(entry.outputs || {})) {
    if (out.images) images.push(...out.images);
  }
  return { images };
}

async function getOutputVideos(promptId) {
  const res = await fetch(`${baseUrl()}/history/${promptId}`);
  if (!res.ok) throw new Error(`ComfyUI history error ${res.status}`);
  const data = await res.json();
  const entry = data[promptId];
  if (!entry) throw new Error('No history entry for prompt');

  const VIDEO_EXTS = /\.(mp4|webm|gif|mov|avi|mkv|webp)$/i;
  const videos = [];

  for (const out of Object.values(entry.outputs || {})) {
    for (const val of Object.values(out)) {
      if (!Array.isArray(val)) continue;
      for (const item of val) {
        if (item?.filename && VIDEO_EXTS.test(item.filename)) videos.push(item);
      }
    }
  }

  if (!videos.length) {
    console.log('[comfyui] getOutputVideos: no video found. History outputs:', JSON.stringify(entry.outputs ?? {}, null, 2));
  }

  return { videos };
}

// Returns { videos, warning? }. Video graphs may write a fallback file before
// a later node fails (e.g. a silent copy saved before the audio mux, which has
// thrown on NaN audio samples) — ComfyUI keeps the outputs of nodes that
// finished, so on an execution error we hand back whatever video was written
// with the error as a warning rather than losing a half-hour take.
async function generateVideo(workflow, onProgress, opts = {}) {
  const clientId = uuidv4();
  const promptId = await queuePrompt(workflow, clientId);
  try {
    await waitForCompletion(promptId, clientId, onProgress, null, opts.signal);
  } catch (err) {
    if (err.message === 'Stopped' || !err.message.startsWith('ComfyUI')) throw err;
    const { videos } = await getOutputVideos(promptId).catch(() => ({ videos: [] }));
    if (!videos.length) throw err;
    console.warn(`[comfyui] job failed after writing a video — keeping it. ${err.message}`);
    return { videos, warning: `Kept a video written before ComfyUI failed — ${err.message}` };
  }
  return getOutputVideos(promptId);
}

// ── Model/asset lists ──────────────────────────────────────────────────────

async function fetchInputList(nodeType, inputName) {
  const res = await fetch(`${baseUrl()}/object_info/${nodeType}`);
  if (!res.ok) throw new Error(`ComfyUI object_info error ${res.status}`);
  const data = await res.json();
  const inputs = data?.[nodeType]?.input ?? {};
  const field = inputs.required?.[inputName] ?? inputs.optional?.[inputName];
  if (!field) return [];
  // New ComfyUI format: ["COMBO", { options: [...] }]
  if (Array.isArray(field[1]?.options)) return field[1].options;
  // Old ComfyUI format: [["file1", "file2"], {}]
  if (Array.isArray(field[0])) return field[0];
  return [];
}

function listLoras() {
  return fetchInputList('LoraLoader', 'lora_name');
}

// Safetensors header metadata for a lora file (ComfyUI /view_metadata endpoint).
// Returns null when the endpoint or file is unavailable.
async function getLoraMetadata(filename) {
  try {
    const res = await fetch(`${baseUrl()}/view_metadata/loras?filename=${encodeURIComponent(filename)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// Whether a node class is installed (used to detect optional custom node packs).
async function hasNode(nodeType) {
  try {
    const res = await fetch(`${baseUrl()}/object_info/${nodeType}`);
    if (!res.ok) return false;
    return !!(await res.json())?.[nodeType];
  } catch { return false; }
}

async function getAssets() {
  // Ask ComfyUI to flush its in-memory model file cache before we query.
  // POST /api/models/refresh exists in ComfyUI 0.3+; silently ignored on older builds.
  await fetch(`${baseUrl()}/api/models/refresh`, { method: 'POST' }).catch(() => {});

  const [checkpoints, vaes, clips, unets, upscaleModels, ipAdapterModels, clipVisionModels, reduxModels, loras, controlNets] = await Promise.allSettled([
    fetchInputList('CheckpointLoaderSimple', 'ckpt_name'),
    fetchInputList('VAELoader',              'vae_name'),
    fetchInputList('CLIPLoader',             'clip_name'),
    fetchInputList('UNETLoader',             'unet_name'),
    fetchInputList('UpscaleModelLoader',     'model_name'),
    fetchInputList('IPAdapterModelLoader',   'ipadapter_file'),
    fetchInputList('CLIPVisionLoader',       'clip_name'),
    fetchInputList('StyleModelLoader',       'style_model_name'),
    fetchInputList('LoraLoader',             'lora_name'),
    fetchInputList('ControlNetLoader',       'control_net_name'),
  ]);

  const all = [checkpoints, vaes, clips, unets, upscaleModels, ipAdapterModels, clipVisionModels, reduxModels, loras, controlNets];
  return {
    checkpoints:      checkpoints.status      === 'fulfilled' ? checkpoints.value      : [],
    vaes:             vaes.status             === 'fulfilled' ? vaes.value             : [],
    clips:            clips.status            === 'fulfilled' ? clips.value            : [],
    unets:            unets.status            === 'fulfilled' ? unets.value            : [],
    upscaleModels:    upscaleModels.status    === 'fulfilled' ? upscaleModels.value    : [],
    ipAdapterModels:  ipAdapterModels.status  === 'fulfilled' ? ipAdapterModels.value  : [],
    clipVisionModels: clipVisionModels.status === 'fulfilled' ? clipVisionModels.value : [],
    reduxModels:      reduxModels.status      === 'fulfilled' ? reduxModels.value      : [],
    loras:            loras.status            === 'fulfilled' ? loras.value            : [],
    controlNets:      controlNets.status      === 'fulfilled' ? controlNets.value      : [],
    errors: all.filter(r => r.status === 'rejected').map(r => r.reason.message),
  };
}

// ── Image upload ───────────────────────────────────────────────────────────────

async function uploadImage(buffer, filename) {
  const form = new FormData();
  form.append('image', new Blob([buffer]), filename);
  const res = await fetch(`${baseUrl()}/upload/image`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`ComfyUI upload error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { filename: data.name, subfolder: data.subfolder ?? '', type: data.type ?? 'input' };
}

async function interrupt() {
  try { await fetch(`${baseUrl()}/interrupt`, { method: 'POST' }); } catch { /* best effort */ }
}

module.exports = { generate, generateVideo, getOutputVideos, getAssets, listLoras, getLoraMetadata, hasNode, uploadImage, interrupt };

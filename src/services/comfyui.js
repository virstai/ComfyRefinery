'use strict';

const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const config = require('./config');

const baseUrl = () => config.load().comfyuiUrl;
const wsUrl   = () => baseUrl().replace(/^http/, 'ws');

// ── Generation ─────────────────────────────────────────────────────────────

async function generate(workflow, onProgress, onPreview) {
  const clientId = uuidv4();
  const promptId = await queuePrompt(workflow, clientId);
  await waitForCompletion(promptId, clientId, onProgress, onPreview);
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

function waitForCompletion(promptId, clientId, onProgress, onPreview) {
  return new Promise((resolve, reject) => {
    let done        = false;
    let ws          = null;
    let reconnects  = 0;
    const MAX_RECONNECTS = 30;

    const finish = (err) => {
      if (done) return;
      done = true;
      try { ws?.close(); } catch {}
      err ? reject(err) : resolve();
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
          const msgs   = status.messages ?? [];
          const errMsg = msgs.find(([t]) => t === 'execution_error')?.[1]?.exception_message;
          throw new Error(`ComfyUI: ${errMsg || 'execution error'}`);
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
            const detail = msg.data?.exception_message || msg.data?.error || 'execution error';
            finish(new Error(`ComfyUI: ${detail}`));
          }
        }
      } catch { /* ignore parse errors */ }
    };

    const connect = () => {
      if (done) return;
      ws = new WebSocket(`${wsUrl()}/ws?clientId=${clientId}`);
      ws.on('open',    ()          => { reconnects = 0; });
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

async function generateVideo(workflow, onProgress) {
  const clientId = uuidv4();
  const promptId = await queuePrompt(workflow, clientId);
  await waitForCompletion(promptId, clientId, onProgress, null);
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

async function getAssets() {
  // Ask ComfyUI to flush its in-memory model file cache before we query.
  // POST /api/models/refresh exists in ComfyUI 0.3+; silently ignored on older builds.
  await fetch(`${baseUrl()}/api/models/refresh`, { method: 'POST' }).catch(() => {});

  const [checkpoints, vaes, clips, unets, upscaleModels, ipAdapterModels, clipVisionModels, reduxModels] = await Promise.allSettled([
    fetchInputList('CheckpointLoaderSimple', 'ckpt_name'),
    fetchInputList('VAELoader',              'vae_name'),
    fetchInputList('CLIPLoader',             'clip_name'),
    fetchInputList('UNETLoader',             'unet_name'),
    fetchInputList('UpscaleModelLoader',     'model_name'),
    fetchInputList('IPAdapterModelLoader',   'ipadapter_file'),
    fetchInputList('CLIPVisionLoader',       'clip_name'),
    fetchInputList('StyleModelLoader',       'style_model_name'),
  ]);

  const all = [checkpoints, vaes, clips, unets, upscaleModels, ipAdapterModels, clipVisionModels, reduxModels];
  return {
    checkpoints:      checkpoints.status      === 'fulfilled' ? checkpoints.value      : [],
    vaes:             vaes.status             === 'fulfilled' ? vaes.value             : [],
    clips:            clips.status            === 'fulfilled' ? clips.value            : [],
    unets:            unets.status            === 'fulfilled' ? unets.value            : [],
    upscaleModels:    upscaleModels.status    === 'fulfilled' ? upscaleModels.value    : [],
    ipAdapterModels:  ipAdapterModels.status  === 'fulfilled' ? ipAdapterModels.value  : [],
    clipVisionModels: clipVisionModels.status === 'fulfilled' ? clipVisionModels.value : [],
    reduxModels:      reduxModels.status      === 'fulfilled' ? reduxModels.value      : [],
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

module.exports = { generate, generateVideo, getOutputVideos, getAssets, uploadImage, interrupt };

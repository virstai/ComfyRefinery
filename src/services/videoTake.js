'use strict';

// One ComfyUI video job, from a built graph to a usable output ref — shared by
// the pipeline's video step (src/routes/generate.js runVideoStep) and Film
// takes (src/services/filmRunner.js). Callers own everything around it: prompt
// building, seed choice, graph building, and persistence. `emit(event, data)`
// receives `progress`, `warning` and `video` with no addressing — the caller
// adds step/iteration or segment/take fields.

const comfyui = require('./comfyui');
const llm     = require('./llm');
const video   = require('../steps/video');

function pickSeed(params = {}) {
  return params.seed == null ? Math.floor(Math.random() * 2 ** 32) : params.seed;
}

function comfyVideoUrl(ref) {
  return `/api/video?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder ?? '')}&type=${encodeURIComponent(ref.type ?? 'output')}`;
}

// → { videoRef, videoUrl, warnings }. Throws 'Generation stopped by user' when
// `isKilled()` reports a stop after the job returns (an aborted `signal`
// rejects the wait itself with 'Stopped').
async function generateTake({ workflow, cfg = null, signal, isKilled = () => false, emit = () => {}, tag = '' }) {
  const warnings = [];
  // A video job runs for minutes and never needs the LLM — let the LLM server
  // free its GPU memory first when the user configured a way to ask for it.
  if (cfg?.llmUnloadEnabled && await llm.release(cfg)) {
    if (tag) console.log(`[${tag}] asked the LLM server to release its GPU memory (${cfg.llmUnloadUrl})`);
  }
  const { videos, warning } = await comfyui.generateVideo(
    workflow,
    pct => {
      emit('progress', { pct });
      if (tag) process.stdout.write(`\r[${tag}] generating ${pct}%   `);
    },
    { signal },
  );
  if (tag) process.stdout.write('\n');

  if (isKilled()) throw new Error('Generation stopped by user');
  if (!videos.length) throw new Error('ComfyUI returned no video output');

  if (warning) {
    warnings.push(warning);
    emit('warning', { message: warning });
    if (tag) console.warn(`[${tag}] ${warning}`);
  }

  const videoRef = video.pickPrimaryVideo(videos);
  const videoUrl = comfyVideoUrl(videoRef);
  if (tag) console.log(`[${tag}] video ready — ${videoRef.filename}`);
  emit('video', { url: videoUrl });
  return { videoRef, videoUrl, warnings };
}

module.exports = { generateTake, pickSeed, comfyVideoUrl };

'use strict';

const { normalizeDevices } = require('../workflows/lib/devicePlacement');

const fs   = require('fs');
const path = require('path');

const dataDir    = () => process.env.DATA_DIR    || path.join(__dirname, '../../data');
const configPath = () => path.join(dataDir(), 'config.json');

const GLOBAL_DEFAULTS = {
  llmBaseUrl:             'http://127.0.0.1:11434/v1',
  llmApiKey:              '',
  comfyuiUrl:             'http://127.0.0.1:8188',
  llmProvider:            'openai',
  llmModel:               '',
  activeWorkflow:         null,
  maxIterations:          3,
  humanReview:            false,
  acceptanceGracePeriod:  10, // seconds; 0 = disabled
  skillRefinement:        true,
  reviewEnabled:          true,
  promptRefinement:       true,
  llmExtras:              true,
  // Optional, off by default: an HTTP call that makes the LLM server release its GPU memory, made right
  // before long ComfyUI video jobs (which never need the LLM mid-job). Only useful when the LLM and
  // ComfyUI share a GPU; the OpenAI-compatible API has no such call, so it is server-specific — e.g.
  // llama-swap: GET /unload; Ollama: POST /api/generate {"model":"{model}","keep_alive":0}. See README.
  llmUnloadEnabled:       false,
  llmUnloadUrl:           '',
  llmUnloadMethod:        'GET',   // GET | POST
  llmUnloadBody:          '',      // optional JSON body for POST; "{model}" is replaced with llmModel
  fileArchTags:           {},  // "<kind>:<filename>" → [arch, ...]; filters model-file pickers (System page)
  models:                 {},
  workflows:              {},
  loras:                  {},
};

// Model loader fields only — sampling params live in workflow steps.
const MODEL_LOADER_FIELDS = new Set([
  'id', 'label', 'architecture', 'checkpoint', 'unetName', 'unetName2', 'modelQuantization', 'vaePrecision', 'clipL', 't5xxl',
  'clipName', 'vaeName', 'vae', 'useRefiner', 'refinerCheckpoint',
  'adapterModel', 'clipVisionModel', 'adapterWeight', 'controlNetModel', 'tileControlNetModel', 'structuralControlNetModel', 'structuralControlNetPreprocessor',
  'distilledLoraName', 'enableAudio',
  'upscaleModel', 'samplingMode',   // ltxvideo: spatial latent upscaler (two-stage) + distilled/full recipe
  'refUnetName', 'audioVaeName', 'refDistilledLoraName',
  'devices',   // per-component placement (ComfyUI-MultiGPU) — see workflows/lib/devicePlacement.js
]);

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* no file yet */ }

  const merged = {
    ...GLOBAL_DEFAULTS,
    ...saved,
  };

  // Back-compat: ollamaUrl → llmBaseUrl (configs written before this refactor)
  if (!merged.llmBaseUrl && merged.ollamaUrl) {
    merged.llmBaseUrl = merged.ollamaUrl.replace(/\/+$/, '') + '/v1';
  }
  // Back-compat: llmProvider 'ollama' → 'openai' (same API, different endpoint)
  if (merged.llmProvider === 'ollama') merged.llmProvider = 'openai';
  // Back-compat: configs written before llmModel was introduced used ollamaModel.
  if (!merged.llmModel && merged.ollamaModel) merged.llmModel = merged.ollamaModel;

  return merged;
}

function save(updates) {
  const next = { ...load(), ...updates };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  return next;
}

// Returns the active workflow config object, or throws if none is set / not found.
function activeWorkflow() {
  const cfg = load();
  if (!cfg.activeWorkflow) throw new Error('No active workflow selected. Configure one in Workflows.');
  const workflow = cfg.workflows[cfg.activeWorkflow];
  if (!workflow) throw new Error(`Active workflow "${cfg.activeWorkflow}" not found in config.`);
  return workflow;
}

// Upsert a workflow entry. id is the key; if omitted a slug is generated from the label.
function saveWorkflow(id, workflowData) {
  const cfg = load();
  const resolvedId = id || slugify(workflowData.label);
  cfg.workflows[resolvedId] = { ...workflowData, id: resolvedId };
  save(cfg);
  return cfg.workflows[resolvedId];
}

function deleteWorkflow(id) {
  const cfg = load();
  delete cfg.workflows[id];
  if (cfg.activeWorkflow === id) cfg.activeWorkflow = null;
  save(cfg);
}

// Upsert a model entry, keeping only loader fields (plus preserving notes).
function saveModel(id, modelData) {
  const cfg = load();
  const resolvedId = id || slugify(modelData.label);
  const loaderData = Object.fromEntries(
    Object.entries(modelData).filter(([k]) => MODEL_LOADER_FIELDS.has(k)),
  );
  const existingNotes = cfg.models[resolvedId]?.notes;
  const notes = modelData.notes !== undefined ? modelData.notes : existingNotes;
  const devices = normalizeDevices(loaderData.devices);
  if (devices) loaderData.devices = devices; else delete loaderData.devices;
  cfg.models[resolvedId] = { ...loaderData, id: resolvedId, ...(notes?.length ? { notes } : {}) };
  save(cfg);
  return cfg.models[resolvedId];
}

// Tag a model file with the architectures it belongs to; [] removes the tag.
function setFileArchTags(key, archs) {
  const cfg  = load();
  const tags = { ...(cfg.fileArchTags ?? {}) };
  if (archs?.length) tags[key] = [...new Set(archs)]; else delete tags[key];
  save({ fileArchTags: tags });
  return tags;
}

// Update only the notes field on a model (user and auto notes).
function saveModelNotes(modelId, notes) {
  const cfg = load();
  if (!cfg.models[modelId]) return null;
  cfg.models[modelId] = { ...cfg.models[modelId], notes };
  save(cfg);
  return cfg.models[modelId];
}

function deleteModel(id) {
  const cfg = load();
  delete cfg.models[id];
  save(cfg);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || Date.now().toString();
}

module.exports = { load, save, activeWorkflow, saveWorkflow, deleteWorkflow, saveModel, saveModelNotes, deleteModel, setFileArchTags };

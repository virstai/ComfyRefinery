'use strict';

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
  models:                 {},
  workflows:              {},
};

// Model loader fields only — sampling params live in workflow steps.
const MODEL_LOADER_FIELDS = new Set([
  'id', 'label', 'architecture', 'checkpoint', 'unetName', 'unetName2', 'modelQuantization', 'vaePrecision', 'clipL', 't5xxl',
  'clipName', 'vaeName', 'vae', 'useRefiner', 'refinerCheckpoint',
  'adapterModel', 'clipVisionModel', 'adapterWeight',
]);

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* no file yet */ }

  const merged = {
    ...GLOBAL_DEFAULTS,
    ...saved,
    // OLLAMA_URL env var: append /v1 to get the OpenAI-compat base URL
    ...(process.env.OLLAMA_URL   && { llmBaseUrl: process.env.OLLAMA_URL.replace(/\/+$/, '') + '/v1' }),
    ...(process.env.COMFYUI_URL  && { comfyuiUrl: process.env.COMFYUI_URL }),
    ...(process.env.OLLAMA_MODEL && { llmModel:   process.env.OLLAMA_MODEL }),
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

// Upsert a model entry, keeping only loader fields.
function saveModel(id, modelData) {
  const cfg = load();
  const resolvedId = id || slugify(modelData.label);
  const loaderData = Object.fromEntries(
    Object.entries(modelData).filter(([k]) => MODEL_LOADER_FIELDS.has(k)),
  );
  cfg.models[resolvedId] = { ...loaderData, id: resolvedId };
  save(cfg);
  return cfg.models[resolvedId];
}

function deleteModel(id) {
  const cfg = load();
  delete cfg.models[id];
  save(cfg);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || Date.now().toString();
}

module.exports = { load, save, activeWorkflow, saveWorkflow, deleteWorkflow, saveModel, deleteModel };

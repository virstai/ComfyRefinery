'use strict';

const express = require('express');
const router  = express.Router();
const config    = require('../services/config');
const comfyui   = require('../services/comfyui');
const llm       = require('../services/llm');
const skills    = require('../services/skills');
const { refreshSkill } = require('../services/skillRefresher');
const { architectures, archMeta, getDefaults } = require('../workflows');
const loraRegistry = require('../services/loraRegistry');

// GET /api/sessions/config
router.get('/config', (req, res) => res.json(config.load()));

// PATCH /api/sessions/config — update global settings
router.patch('/config', (req, res) => {
  try {
    const { models: _m, workflows: _w, ...updates } = req.body;
    res.json(config.save(updates));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workflow registry ──────────────────────────────────────────────────────────

// GET /api/sessions/workflows
router.get('/workflows', (req, res) => {
  const { workflows, activeWorkflow } = config.load();
  res.json({ workflows, activeWorkflow });
});

// PUT /api/sessions/workflows/:id — create or replace a workflow config
router.put('/workflows/:id', (req, res) => {
  try {
    const saved = config.saveWorkflow(req.params.id, req.body);
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sessions/workflows — create a new workflow (id derived from label)
router.post('/workflows', (req, res) => {
  try {
    const saved = config.saveWorkflow(null, req.body);
    res.status(201).json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/sessions/workflows/:id
router.delete('/workflows/:id', (req, res) => {
  config.deleteWorkflow(req.params.id);
  res.status(204).end();
});

// ── Model registry ─────────────────────────────────────────────────────────────

// GET /api/sessions/models/list — all configured models
router.get('/models/list', (req, res) => {
  const { models } = config.load();
  res.json({ models });
});

// PUT /api/sessions/models/:id — create or replace a model config
router.put('/models/:id', (req, res) => {
  try {
    const saved = config.saveModel(req.params.id, req.body);
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/sessions/models — create a new model (id derived from label)
router.post('/models', (req, res) => {
  try {
    const saved = config.saveModel(null, req.body);
    res.status(201).json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/sessions/models/:id
router.delete('/models/:id', (req, res) => {
  config.deleteModel(req.params.id);
  res.status(204).end();
});

// ── Skill registry ─────────────────────────────────────────────────────────────

// GET /api/sessions/skills/:workflowId
router.get('/skills/:workflowId', (req, res) => {
  res.json(skills.get(req.params.workflowId) ?? {});
});

// POST /api/sessions/skills/:workflowId/refresh
router.post('/skills/:workflowId/refresh', async (req, res) => {
  const { note = '' } = req.body;
  const cfg = config.load();
  const workflow = cfg.workflows?.[req.params.workflowId];
  if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
  if (!cfg.llmModel) return res.status(400).json({ error: 'No LLM model configured' });

  const skillData = skills.get(req.params.workflowId);
  if (skillData?.skillLocked) return res.status(400).json({ error: 'Skill is locked. Unlock it before refreshing.' });

  const firstGenStep = (workflow.steps ?? []).find(s => s.type === 'generate');
  const modelConfig  = cfg.models?.[firstGenStep?.modelId];
  const arch = modelConfig?.architecture ?? 'unknown';

  try {
    await refreshSkill(req.params.workflowId, workflow.label, arch, note.trim());
    res.json(skills.get(req.params.workflowId) ?? {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/sessions/skills/:workflowId/notes
router.patch('/skills/:workflowId/notes', (req, res) => {
  try {
    skills.saveNotes(req.params.workflowId, req.body.notes ?? []);
    res.json(skills.get(req.params.workflowId) ?? {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/skills/:workflowId/versions/:versionId/activate
router.post('/skills/:workflowId/versions/:versionId/activate', (req, res) => {
  const data = skills.activateVersion(req.params.workflowId, req.params.versionId);
  if (!data) return res.status(404).json({ error: 'Version not found' });
  res.json(data);
});

// DELETE /api/sessions/skills/:workflowId/versions/:versionId
router.delete('/skills/:workflowId/versions/:versionId', (req, res) => {
  try {
    const data = skills.deleteVersion(req.params.workflowId, req.params.versionId);
    if (!data) return res.status(404).json({ error: 'Version not found' });
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/sessions/skills/:workflowId/lock
router.patch('/skills/:workflowId/lock', (req, res) => {
  const data = skills.setLocked(req.params.workflowId, req.body.locked);
  if (!data) return res.status(404).json({ error: 'Skill not found' });
  res.json(data);
});

// ── LoRA registry ──────────────────────────────────────────────────────────────

// GET /api/sessions/loras — current registry
router.get('/loras', (req, res) => {
  res.json({ loras: config.load().loras ?? {} });
});

// POST /api/sessions/loras/scan — sync registry against ComfyUI's lora list
router.post('/loras/scan', async (req, res) => {
  try { res.json({ loras: await loraRegistry.scan() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/sessions/loras — update one entry (filename in body: may contain "/")
router.put('/loras', (req, res) => {
  try {
    const { filename, ...data } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    res.json(loraRegistry.saveLora(filename, data));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Architecture metadata ──────────────────────────────────────────────────────

// GET /api/sessions/architectures
router.get('/architectures', (req, res) => {
  const result = {};
  for (const arch of architectures) {
    result[arch] = { ...archMeta[arch], defaults: getDefaults(arch) };
  }
  res.json(result);
});

// ── Available assets from ComfyUI + Ollama ────────────────────────────────────

// GET /api/sessions/assets — checkpoints, vaes, clips, unets + ollama models
router.get('/assets', async (req, res) => {
  const cfg = config.load();
  const [comfyAssets, llmModels] = await Promise.allSettled([
    comfyui.getAssets(),
    llm.listModels(cfg),
  ]);

  const comfy  = comfyAssets.status === 'fulfilled' ? comfyAssets.value : { checkpoints: [], vaes: [], clips: [], unets: [], upscaleModels: [], ipAdapterModels: [], clipVisionModels: [], reduxModels: [], loras: [], controlNets: [], errors: [comfyAssets.reason.message] };
  const models = llmModels.status === 'fulfilled' ? llmModels.value : [];

  res.json({
    llm:     models,
    comfyui: comfy,
    errors:  [...(comfy.errors || []), ...(llmModels.status === 'rejected' ? [llmModels.reason.message] : [])],
  });
});

module.exports = router;

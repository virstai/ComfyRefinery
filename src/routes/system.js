'use strict';

// System page: what this ComfyUI / LLM setup can run — versions, devices,
// node packs (required / optional, installed or not), per-arch availability,
// model files, and the file → architecture tags that filter model pickers.

const express  = require('express');
const config   = require('../services/config');
const comfyui  = require('../services/comfyui');
const llm      = require('../services/llm');
const ffmpeg   = require('../services/ffmpeg');
const { inspect } = require('../services/nodeRequirements');
const { architectures } = require('../workflows');

const router = express.Router();

// GET /api/system/info
router.get('/info', async (req, res) => {
  const cfg = config.load();
  const [stats, nodeIndex, samplers, assets, llmModels, ffmpegInfo] = await Promise.allSettled([
    comfyui.getSystemStats(),
    comfyui.getNodeIndex(),
    comfyui.fetchInputList('KSampler', 'sampler_name'),
    comfyui.getAssets(),
    llm.listModels(cfg),
    ffmpeg.detect({ refresh: true }),
  ]);
  const sys = stats.status === 'fulfilled' ? stats.value : null;
  const requirements = inspect({
    nodeIndex:   nodeIndex.status === 'fulfilled' ? nodeIndex.value : {},
    samplers:    samplers.status  === 'fulfilled' ? samplers.value  : [],
    coreVersion: sys?.system?.comfyui_version ?? null,
  });
  const a = assets.status === 'fulfilled' ? assets.value : null;
  const { errors: _e, devices: _d, multiGpu: _m, ...files } = a ?? {};

  res.json({
    comfyui: {
      url:       cfg.comfyuiUrl,
      reachable: !!sys,
      error:     stats.status === 'rejected' ? stats.reason.message : null,
      version:   sys?.system?.comfyui_version ?? null,
      pytorch:   sys?.system?.pytorch_version ?? null,
      python:    sys?.system?.python_version?.split(' ')[0] ?? null,
      os:        sys?.system?.os ?? null,
      argv:      sys?.system?.argv ?? [],
      ramTotal:  sys?.system?.ram_total ?? null,
      ramFree:   sys?.system?.ram_free ?? null,
      packages:  sys?.system?.comfy_package_versions ?? [],
      devices:   a?.devices ?? [],
      multiGpu:  a?.multiGpu ?? false,
    },
    llm: {
      baseUrl:   cfg.llmBaseUrl,
      model:     cfg.llmModel,
      reachable: llmModels.status === 'fulfilled',
      error:     llmModels.status === 'rejected' ? llmModels.reason.message : null,
      models:    llmModels.status === 'fulfilled' ? llmModels.value : [],
    },
    nodeIndexAvailable: nodeIndex.status === 'fulfilled',
    // Host tools outside ComfyUI. ffmpeg backs the Film view (last-frame
    // capture, reference captures, export stitching).
    tools: {
      ffmpeg: ffmpegInfo.status === 'fulfilled'
        ? ffmpegInfo.value
        : { available: false, path: null, version: null, ffprobe: false, error: ffmpegInfo.reason?.message ?? 'detect failed' },
    },
    ...requirements,
    files:        a ? files : {},
    fileArchTags: cfg.fileArchTags ?? {},
    architectures,
  });
});

// GET /api/system/file-tags → { "<kind>:<filename>": ["anima", ...] }
router.get('/file-tags', (req, res) => res.json(config.load().fileArchTags ?? {}));

// PUT /api/system/file-tags { key, archs } — archs [] clears the tag
router.put('/file-tags', (req, res) => {
  const { key, archs } = req.body ?? {};
  if (typeof key !== 'string' || !key.includes(':')) return res.status(400).json({ error: 'key must be "<kind>:<filename>"' });
  if (!Array.isArray(archs) || archs.some(x => !architectures.includes(x))) {
    return res.status(400).json({ error: `archs must be an array of known architectures (${architectures.join(', ')})` });
  }
  res.json(config.setFileArchTags(key, archs));
});

module.exports = router;

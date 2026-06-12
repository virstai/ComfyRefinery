'use strict';

// LoRA registry: maps ComfyUI lora filenames to architecture + LLM usage info.
// Scan syncs against ComfyUI's lora list; user edits (autoDetected: false) are
// never overwritten and removed files are pruned.

const config  = require('./config');
const comfyui = require('./comfyui');
const { detectArchitecture } = require('../lib/loraMeta');

async function scan() {
  const available = await comfyui.listLoras();
  const registry  = { ...(config.load().loras ?? {}) };

  for (const name of Object.keys(registry)) {
    if (!available.includes(name)) delete registry[name];
  }

  for (const filename of available) {
    if (registry[filename]) continue;
    const metadata = await comfyui.getLoraMetadata(filename);
    registry[filename] = {
      filename,
      label:         filename.replace(/\.(safetensors|pt|ckpt)$/i, '').split('/').pop(),
      architecture:  detectArchitecture(metadata),
      triggerWords:  [],
      description:   '',
      defaultWeight: 1.0,
      autoDetected:  true,
    };
  }

  config.save({ loras: registry });
  return registry;
}

function saveLora(filename, data) {
  const cfg      = config.load();
  const existing = cfg.loras?.[filename];
  if (!existing) throw new Error(`LoRA "${filename}" not in registry — rescan first`);
  const updated = {
    ...existing,
    label:         data.label !== undefined ? data.label : existing.label,
    architecture:  data.architecture !== undefined ? (data.architecture || null) : existing.architecture,
    triggerWords:  Array.isArray(data.triggerWords) ? data.triggerWords : existing.triggerWords,
    description:   data.description   !== undefined ? data.description   : existing.description,
    defaultWeight: data.defaultWeight !== undefined ? Number(data.defaultWeight) : existing.defaultWeight,
    autoDetected:  false,
  };
  config.save({ loras: { ...cfg.loras, [filename]: updated } });
  return updated;
}

module.exports = { scan, saveLora };

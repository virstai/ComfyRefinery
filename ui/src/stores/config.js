import { reactive } from 'vue';
import { api } from '../api.js';

export const configState = reactive({
  config:   {},
  assets:   { llm: [], comfyui: { checkpoints: [], vaes: [], clips: [], unets: [], upscaleModels: [] } },
  archMeta: {},
});

export async function loadConfig() {
  const [config, archMeta] = await Promise.all([
    api('GET', '/api/sessions/config'),
    api('GET', '/api/sessions/architectures'),
  ]);
  configState.config   = config;
  configState.archMeta = archMeta;
}

export async function saveConfig(updates) {
  configState.config = await api('PATCH', '/api/sessions/config', updates);
  return configState.config;
}

export async function loadAssets() {
  configState.assets = await api('GET', '/api/sessions/assets');
  return configState.assets;
}

export async function saveWorkflow(id, data) {
  if (id) {
    await api('PUT', `/api/sessions/workflows/${id}`, data);
  } else {
    await api('POST', '/api/sessions/workflows', data);
  }
  configState.config = await api('GET', '/api/sessions/config');
}

export async function deleteWorkflow(id) {
  await api('DELETE', `/api/sessions/workflows/${id}`);
  configState.config = await api('GET', '/api/sessions/config');
}

export async function setActiveWorkflow(id) {
  configState.config = await api('PATCH', '/api/sessions/config', { activeWorkflow: id || null });
}

export async function saveModel(id, data) {
  if (id) {
    await api('PUT', `/api/sessions/models/${id}`, data);
  } else {
    await api('POST', '/api/sessions/models', data);
  }
  configState.config = await api('GET', '/api/sessions/config');
}

export async function deleteModel(id) {
  await api('DELETE', `/api/sessions/models/${id}`);
  configState.config = await api('GET', '/api/sessions/config');
}

export async function loadSkill(modelId) {
  return api('GET', `/api/sessions/skills/${encodeURIComponent(modelId)}`);
}

export async function saveNotes(modelId, notes) {
  return api('PATCH', `/api/sessions/skills/${encodeURIComponent(modelId)}/notes`, { notes });
}

export async function refreshSkill(modelId, note = '') {
  return api('POST', `/api/sessions/skills/${encodeURIComponent(modelId)}/refresh`, { note });
}

export async function activateSkillVersion(modelId, versionId) {
  return api('POST', `/api/sessions/skills/${encodeURIComponent(modelId)}/versions/${encodeURIComponent(versionId)}/activate`);
}

export async function deleteSkillVersion(modelId, versionId) {
  return api('DELETE', `/api/sessions/skills/${encodeURIComponent(modelId)}/versions/${encodeURIComponent(versionId)}`);
}

export async function setSkillLocked(modelId, locked) {
  return api('PATCH', `/api/sessions/skills/${encodeURIComponent(modelId)}/lock`, { locked });
}

export async function resetSkillToDefault(modelId) {
  return api('POST', `/api/sessions/skills/${encodeURIComponent(modelId)}/reset`);
}

export async function loadLoras() {
  return (await api('GET', '/api/sessions/loras')).loras ?? {};
}

export async function scanLoras() {
  return (await api('POST', '/api/sessions/loras/scan')).loras ?? {};
}

export async function saveLora(filename, data) {
  return api('PUT', '/api/sessions/loras', { filename, ...data });
}

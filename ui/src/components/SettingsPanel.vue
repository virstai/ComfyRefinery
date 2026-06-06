<template>
  <div style="flex:1;overflow-y:auto;padding:20px 24px">
    <div class="panel-header">
      <h2>Global Settings</h2>
    </div>

    <div class="row">
      <label>LLM base URL <span class="hint">(e.g. http://host:11434/v1 for Ollama)</span>
        <input type="url" v-model="form.llmBaseUrl" placeholder="http://host:11434/v1">
      </label>
      <label>ComfyUI URL
        <input type="url" v-model="form.comfyuiUrl" placeholder="http://host:8188">
      </label>
    </div>

    <label>API key <span class="hint">(leave blank for Ollama / local providers)</span>
      <input type="password" v-model="form.llmApiKey" placeholder="sk-…  or leave blank">
    </label>

    <label>LLM model (prompt building &amp; review)
      <select v-model="form.llmModel">
        <option value="">— select —</option>
        <option v-for="m in assets.llm" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>

    <div class="row">
      <label>Max iterations
        <input type="number" v-model.number="form.maxIterations" min="1" max="20" placeholder="3">
      </label>
      <label>Acceptance grace period <span class="hint">(seconds, 0 = disabled)</span>
        <input type="number" v-model.number="form.acceptanceGracePeriod" min="0" max="300" placeholder="10">
      </label>
    </div>
    <div class="row">
      <label class="checkbox-label" style="align-self:flex-end;padding-bottom:12px">
        <input type="checkbox" v-model="form.humanReview"> Human review after each iteration
      </label>
      <label class="checkbox-label" style="align-self:flex-end;padding-bottom:12px">
        <input type="checkbox" v-model="form.bypassGracePeriod"> Bypass grace period
      </label>
    </div>

    <div class="panel-actions">
      <button class="primary"   @click="save">Save</button>
      <button class="secondary" @click="reloadAssets">Reload asset lists</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, watch } from 'vue';
import { saveConfig, loadAssets } from '../stores/config.js';

const props = defineProps({
  config: { type: Object, default: () => ({}) },
  assets: { type: Object, default: () => ({ llm: [] }) },
});
const emit = defineEmits(['saved']);

const form = reactive({
  llmBaseUrl:            '',
  llmApiKey:             '',
  comfyuiUrl:            '',
  llmModel:              '',
  maxIterations:         '',
  acceptanceGracePeriod: '',
  humanReview:           false,
  bypassGracePeriod:     false,
});

watch(() => props.config, cfg => {
  form.llmBaseUrl            = cfg.llmBaseUrl            ?? '';
  form.llmApiKey             = cfg.llmApiKey             ?? '';
  form.comfyuiUrl            = cfg.comfyuiUrl            ?? '';
  form.llmModel              = cfg.llmModel              ?? '';
  form.maxIterations         = cfg.maxIterations         ?? '';
  form.acceptanceGracePeriod = cfg.acceptanceGracePeriod ?? '';
  form.humanReview           = !!cfg.humanReview;
  form.bypassGracePeriod     = !!cfg.bypassGracePeriod;
}, { immediate: true });

async function save() {
  await saveConfig({
    llmBaseUrl:            form.llmBaseUrl            || null,
    llmApiKey:             form.llmApiKey             || '',
    comfyuiUrl:            form.comfyuiUrl            || null,
    llmModel:              form.llmModel              || null,
    maxIterations:         form.maxIterations         || null,
    acceptanceGracePeriod: form.acceptanceGracePeriod !== '' ? Number(form.acceptanceGracePeriod) : null,
    humanReview:           form.humanReview,
    bypassGracePeriod:     form.bypassGracePeriod,
  });
  emit('saved');
}

async function reloadAssets() {
  await loadAssets();
}
</script>

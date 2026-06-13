<template>
  <div style="flex:1;overflow-y:auto;padding:20px 24px">
    <div class="panel-header">
      <h2>Global Settings</h2>
    </div>

    <h3>ComfyUI</h3>
    <label>URL
      <input type="url" v-model="form.comfyuiUrl" placeholder="http://host:8188">
    </label>

    <hr>

    <h3>LLM</h3>
    <div class="row">
      <label>Base URL <span class="hint">(e.g. http://host:11434/v1 for Ollama)</span>
        <input type="url" v-model="form.llmBaseUrl" placeholder="http://host:11434/v1">
      </label>
      <label>API key <span class="hint">(leave blank for local providers)</span>
        <input type="password" v-model="form.llmApiKey" placeholder="sk-…  or leave blank">
      </label>
    </div>
    <label>Model <span class="hint">(used for prompt building &amp; review)</span>
      <select v-model="form.llmModel">
        <option value="">— select —</option>
        <option v-for="m in assets.llm" :key="m" :value="m">{{ m }}</option>
      </select>
    </label>

    <hr>

    <h3>LLM features</h3>
    <p class="hint" style="margin:-4px 0 12px">Disable all four to run ComfyUI-only with no LLM required.</p>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:4px">
      <label class="checkbox-label">
        <input type="checkbox" v-model="form.promptRefinement"> Prompt refinement
        <span class="hint"> — LLM rewrites the user prompt using the skill before generating</span>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" v-model="form.reviewEnabled"> Image review
        <span class="hint"> — LLM reviews each generated image and retries on rejection</span>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" v-model="form.skillRefinement"> Skill refinement
        <span class="hint"> — LLM updates the model skill after each session</span>
      </label>
      <label class="checkbox-label">
        <input type="checkbox" v-model="form.llmExtras"> Vision guidance &amp; LoRA selection
        <span class="hint"> — LLM reads reference images and selects LoRAs via tool calling</span>
      </label>
    </div>

    <template v-if="form.reviewEnabled">
      <hr>
      <h3>Review</h3>
      <div class="row">
        <label>Max iterations
          <input type="number" v-model.number="form.maxIterations" min="1" max="20" placeholder="3">
        </label>
        <label>Grace period <span class="hint">(seconds, 0 = disabled)</span>
          <input type="number" v-model.number="form.acceptanceGracePeriod" min="0" max="300" placeholder="10">
        </label>
      </div>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <label class="checkbox-label">
          <input type="checkbox" v-model="form.humanReview"> Human review after each iteration
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="form.bypassGracePeriod"> Bypass grace period
        </label>
      </div>
    </template>

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
  promptRefinement:      true,
  reviewEnabled:         true,
  skillRefinement:       true,
  llmExtras:             true,
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
  form.promptRefinement      = cfg.promptRefinement      !== false;
  form.reviewEnabled         = cfg.reviewEnabled         !== false;
  form.skillRefinement       = cfg.skillRefinement       !== false;
  form.llmExtras             = cfg.llmExtras             !== false;
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
    promptRefinement:      form.promptRefinement,
    reviewEnabled:         form.reviewEnabled,
    skillRefinement:       form.skillRefinement,
    llmExtras:             form.llmExtras,
  });
  emit('saved');
}

async function reloadAssets() {
  await loadAssets();
}
</script>

<template>
  <div id="app">
    <Sidebar
      :active-view="activeView"
      :active-workflow="configState.config.activeWorkflow"
      :workflows="configState.config.workflows ?? {}"
      :running="genState.running"
      :active-step-index="genState.activeStepIndex"
      :total-steps="genState.totalSteps"
      :active-step-label="genState.activeStepLabel"
      :active-step-pct="genState.activeStepPct"
      @navigate="activeView = $event"
      @set-active-workflow="setActiveWorkflow"
      @stop="killGeneration"
    />

    <div class="main-area">
      <template v-if="activeView === 'generate'">
        <div v-if="genState.liveRunning && !genState.running" class="live-banner" @click="returnToLive">
          Generation in progress — click to return to live view
        </div>
        <GenerateSection
          :running="genState.running"
          :session-id="genState.sessionId"
          :loaded-desc="genState.loadedDesc"
          :config="configState.config"
          @generate="onGenerate"
          @continue="onContinue"
          @clear="clearSession"
          @open-workflows="activeView = 'workflows'"
          @open-settings="activeView = 'settings'"
        />
        <RunSection
          v-if="genState.steps.length || genState.status"
          :steps="genState.steps"
          :status="genState.status"
          :iter-badge="genState.iterBadge"
          :session-id="genState.sessionId"
          :running="genState.running"
        />
      </template>

      <WorkflowsPanel
        v-else-if="activeView === 'workflows'"
        :config="configState.config"
        :assets="configState.assets"
        :arch-meta="configState.archMeta"
        @changed="onConfigChanged"
      />

      <ModelsPanel
        v-else-if="activeView === 'models'"
        :config="configState.config"
        :assets="configState.assets"
        :arch-meta="configState.archMeta"
        @changed="onConfigChanged"
      />

      <LorasPanel
        v-else-if="activeView === 'loras'"
        :arch-meta="configState.archMeta"
      />

      <QueuePanel
        v-else-if="activeView === 'queue'"
      />

      <HistoryPanel
        v-else-if="activeView === 'history'"
        @load-session="onLoadSession"
      />

      <SettingsPanel
        v-else-if="activeView === 'settings'"
        :config="configState.config"
        :assets="configState.assets"
        @saved="onSettingsSaved"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import Sidebar         from './components/Sidebar.vue';
import GenerateSection from './components/GenerateSection.vue';
import RunSection      from './components/RunSection.vue';
import WorkflowsPanel  from './components/WorkflowsPanel.vue';
import ModelsPanel     from './components/ModelsPanel.vue';
import LorasPanel      from './components/LorasPanel.vue';
import HistoryPanel    from './components/HistoryPanel.vue';
import SettingsPanel   from './components/SettingsPanel.vue';
import QueuePanel      from './components/QueuePanel.vue';

import { configState, loadConfig, loadAssets, setActiveWorkflow as storeSetActiveWorkflow } from './stores/config.js';
import { genState, startGeneration, continueSession, loadSession, clearSession, killGeneration, connectToBroadcast, returnToLive } from './stores/generate.js';

const activeView = ref('generate');

onMounted(async () => {
  connectToBroadcast();
  try {
    await loadConfig();
    await loadAssets();
  } catch (err) {
    console.error('Init error:', err);
  }
});

async function setActiveWorkflow(id) {
  await storeSetActiveWorkflow(id);
}

async function onSettingsSaved() {
  activeView.value = 'generate';
  await loadAssets();
}

async function onConfigChanged() {
  // store already refreshed config via store functions
}

async function onGenerate(prompt, references) {
  activeView.value = 'generate';
  await startGeneration(prompt, references);
}

async function onContinue(sessionId, references) {
  activeView.value = 'generate';
  await continueSession(sessionId, references);
}

async function onLoadSession(sessionId) {
  activeView.value = 'generate';
  await loadSession(sessionId);
}
</script>

<style scoped>
.live-banner {
  padding: 8px 16px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--accent);
  cursor: pointer;
  font-size: 0.8rem;
  text-align: center;
  letter-spacing: 0.02em;
  transition: background 0.15s;
}
.live-banner:hover {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}
</style>

<template>
  <div id="app">
    <Sidebar
      :active-view="activeView"
      :active-workflow="configState.config.activeWorkflow"
      :workflows="configState.config.workflows ?? {}"
      :running="liveStatus.running"
      :active-step-index="liveStatus.activeStepIndex"
      :total-steps="liveStatus.totalSteps"
      :active-step-label="liveStatus.activeStepLabel"
      :active-step-pct="liveStatus.activeStepPct"
      :status-title="liveStatus.title"
      @navigate="activeView = $event"
      @set-active-workflow="setActiveWorkflow"
      @stop="onStop"
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

      <FilmPanel v-else-if="activeView === 'film'" />

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

      <SystemPanel v-else-if="activeView === 'system'" />

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
import { ref, computed, watch, onMounted } from 'vue';
import Sidebar         from './components/Sidebar.vue';
import FilmPanel       from './components/film/FilmPanel.vue';
import GenerateSection from './components/GenerateSection.vue';
import SystemPanel     from './components/SystemPanel.vue';
import RunSection      from './components/RunSection.vue';
import WorkflowsPanel  from './components/WorkflowsPanel.vue';
import ModelsPanel     from './components/ModelsPanel.vue';
import LorasPanel      from './components/LorasPanel.vue';
import HistoryPanel    from './components/HistoryPanel.vue';
import SettingsPanel   from './components/SettingsPanel.vue';
import QueuePanel      from './components/QueuePanel.vue';

import { configState, loadConfig, loadAssets, setActiveWorkflow as storeSetActiveWorkflow } from './stores/config.js';
import { genState, startGeneration, continueSession, loadSession, clearSession, killGeneration, connectToBroadcast, returnToLive } from './stores/generate.js';
import { filmState, openProject, killRun } from './stores/film.js';

// ── Routing: the URL hash mirrors the current view (and loaded session) so a
// refresh lands back where you were — #/history, #/generate/<sessionId>, …
const VIEWS = ['generate', 'film', 'queue', 'workflows', 'models', 'loras', 'history', 'system', 'settings'];
// `param` is a session id under #/generate/… and a project id under #/film/…
function parseHash() {
  const m = location.hash.match(/^#\/([a-z]+)(?:\/([^/?#]+))?/);
  return { view: VIEWS.includes(m?.[1]) ? m[1] : 'generate', param: m?.[2] ?? null };
}
const initialRoute = parseHash();
const activeView   = ref(initialRoute.view);

watch([activeView, () => genState.sessionId, () => filmState.project?.id], ([view, sessionId, projectId]) => {
  const target = view === 'generate' && sessionId ? `#/generate/${sessionId}`
    : view === 'film' && projectId ? `#/film/${projectId}`
    : `#/${view}`;
  if (location.hash !== target) history.replaceState(null, '', target);
});  // not immediate: the URL is already right on load, and a session id must survive until restore runs
window.addEventListener('hashchange', () => {
  const route = parseHash();
  activeView.value = route.view;
  if (route.view === 'film' && route.param && route.param !== filmState.project?.id) {
    openProject(route.param).catch(err => console.warn('Could not open project from URL:', err.message));
  }
});

// Sidebar live-status block: a running Film take takes precedence over Generate.
const liveStatus = computed(() => {
  if (filmState.running) {
    const seg = filmState.project?.segments?.find(s => s.id === filmState.runSegmentId);
    return {
      running: true, activeStepIndex: 0, totalSteps: 1,
      title: 'Take running',
      activeStepLabel: `${seg ? `Segment ${seg.index + 1}` : 'Film'} · ${filmState.status || filmState.phase || '…'}`,
      activeStepPct: filmState.progress,
    };
  }
  return {
    running: genState.running, activeStepIndex: genState.activeStepIndex, totalSteps: genState.totalSteps,
    title: '', activeStepLabel: genState.activeStepLabel, activeStepPct: genState.activeStepPct,
  };
});

function onStop() {
  if (filmState.running) killRun(); else killGeneration();
}

onMounted(async () => {
  connectToBroadcast();
  try {
    await loadConfig();
    await loadAssets();
  } catch (err) {
    console.error('Init error:', err);
  }
  // Restore the session that was open before the refresh (unless a live run
  // has already taken over the view).
  if (initialRoute.view === 'generate' && initialRoute.param && !genState.sessionId && !genState.liveRunning) {
    try { await loadSession(initialRoute.param); }
    catch (err) { console.warn('Could not restore session from URL:', err.message); }
  }
  if (initialRoute.view === 'film' && initialRoute.param) {
    try { await openProject(initialRoute.param); }
    catch (err) { console.warn('Could not restore project from URL:', err.message); }
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

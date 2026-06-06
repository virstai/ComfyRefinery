<template>
  <aside class="sidebar">
    <div class="sidebar-top">
      <div class="sidebar-app-name">ComfyRefinery</div>
      <div
        class="wf-chip"
        :class="{ 'wf-chip--open': chipOpen }"
        ref="chipRoot"
        @click="chipOpen = !chipOpen"
      >
        <div class="wf-chip-header">
          <span class="wf-chip-label">{{ activeWorkflowLabel }}</span>
          <span class="wf-chip-chevron">▾</span>
        </div>
        <div class="wf-chip-meta">{{ activeWorkflowMeta }}</div>

        <div v-if="chipOpen" class="wf-chip-menu" @click.stop>
          <button
            v-for="(wf, id) in workflows"
            :key="id"
            class="wf-chip-option"
            :class="{ 'is-active': id === activeWorkflow }"
            @click="selectWorkflow(id)"
          >
            <span class="wf-chip-option-label">{{ wf.label || id }}</span>
            <span class="wf-chip-option-meta">{{ stepSummary(wf) }}</span>
          </button>
          <div v-if="!Object.keys(workflows).length" class="wf-chip-empty">No workflows</div>
        </div>
      </div>
    </div>

    <nav class="sidebar-nav">
      <div
        v-for="item in navItems"
        :key="item.view"
        class="sidebar-nav-item"
        :class="{ active: activeView === item.view }"
        @click="$emit('navigate', item.view)"
      >
        <span class="sidebar-nav-icon">{{ item.icon }}</span>
        {{ item.label }}
      </div>
    </nav>

    <div v-if="running && totalSteps > 0" class="sidebar-status">
      <div class="sidebar-status-header">
        <span class="sidebar-status-label">
          <span class="sidebar-status-dot"></span>
          Step {{ (activeStepIndex ?? 0) + 1 }} of {{ totalSteps }}
        </span>
        <button class="small danger" @click="$emit('stop')">■ Stop</button>
      </div>
      <div class="sidebar-status-bar">
        <div class="sidebar-status-fill" :style="{ width: activeStepPct + '%' }"></div>
      </div>
      <div class="sidebar-status-detail">{{ activeStepLabel }} · {{ activeStepPct }}%</div>
    </div>
  </aside>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  activeView:      { type: String, default: 'generate' },
  activeWorkflow:  { type: String, default: null },
  workflows:       { type: Object, default: () => ({}) },
  running:         { type: Boolean, default: false },
  activeStepIndex: { type: Number, default: null },
  totalSteps:      { type: Number, default: 0 },
  activeStepLabel: { type: String, default: '' },
  activeStepPct:   { type: Number, default: 0 },
});

const emit = defineEmits(['navigate', 'set-active-workflow', 'stop']);

const chipOpen = ref(false);
const chipRoot = ref(null);

const navItems = [
  { view: 'generate',  icon: '▶', label: 'Generate'  },
  { view: 'workflows', icon: '⬡', label: 'Workflows' },
  { view: 'models',    icon: '⬡', label: 'Models'    },
  { view: 'history',   icon: '☰', label: 'History'   },
  { view: 'settings',  icon: '⚙', label: 'Settings'  },
];

const activeWorkflowLabel = computed(() => {
  const wf = props.workflows[props.activeWorkflow];
  return wf?.label || props.activeWorkflow || '— select workflow —';
});

const activeWorkflowMeta = computed(() => {
  const wf = props.workflows[props.activeWorkflow];
  return wf ? stepSummary(wf) : '';
});

const STEP_LABELS = { generate: 'Generate', upscale: 'Upscale' };
function stepSummary(wf) {
  if (!wf?.steps?.length) return 'No steps';
  return wf.steps.map(s => STEP_LABELS[s.type] ?? s.type).join(' · ');
}

function selectWorkflow(id) {
  emit('set-active-workflow', id);
  chipOpen.value = false;
}

function onOutsideClick(e) {
  if (chipRoot.value && !chipRoot.value.contains(e.target)) chipOpen.value = false;
}
onMounted(()       => document.addEventListener('mousedown', onOutsideClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutsideClick));
</script>

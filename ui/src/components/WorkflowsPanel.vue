<template>
  <div class="two-pane">
    <!-- Left: workflow list -->
    <div class="two-pane-list">
      <div class="two-pane-header">
        <span class="two-pane-header-title">Workflows</span>
        <button class="primary small" @click="startNew">+ New</button>
      </div>
      <div class="two-pane-list-body">
        <div
          v-for="(wf, id) in config.workflows"
          :key="id"
          class="list-row"
          :class="{ selected: selectedId === id }"
          @click="select(id)"
        >
          <div class="list-row-name">{{ wf.label || id }}</div>
          <div class="list-row-meta">{{ stepSummary(wf) }}</div>
          <span v-if="id === config.activeWorkflow" class="list-row-active-chip">● Active</span>
        </div>
        <div v-if="!Object.keys(config.workflows ?? {}).length" style="font-size:12px;color:var(--muted);padding:8px 4px">
          No workflows yet.
        </div>
      </div>
    </div>

    <!-- Right: editor -->
    <div class="two-pane-detail">
      <div class="editor-header">
        <template v-if="selectedId !== null">
          <span class="editor-header-name">{{ isAdding ? 'New workflow' : (config.workflows[selectedId]?.label || selectedId) }}</span>
          <button
            v-if="!isAdding && selectedId !== config.activeWorkflow"
            class="secondary small"
            @click="setActive"
          >Set active</button>
          <span
            v-else-if="!isAdding"
            style="font-size:10px;color:var(--accent);background:color-mix(in srgb,var(--accent) 15%,transparent);padding:2px 8px;border-radius:8px"
          >● Active</span>
          <button v-if="!isAdding" class="secondary small" @click="duplicate" :disabled="saving">Duplicate</button>
          <button v-if="!isAdding" class="danger small" @click="del" :disabled="saving">Delete</button>
        </template>
      </div>
      <div v-if="selectedId !== null" class="two-pane-detail-body">
        <WorkflowEditor
          :key="selectedId"
          :workflow-id="isAdding ? null : selectedId"
          :workflow="isAdding ? null : config.workflows[selectedId]"
          :config="config"
          :arch-meta="archMeta"
          :assets="assets"
          @saved="onSaved"
          @deleted="onDeleted"
        />
      </div>
      <div v-else class="two-pane-placeholder">Select a workflow to edit</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import WorkflowEditor from './WorkflowEditor.vue';
import { setActiveWorkflow, saveWorkflow, deleteWorkflow, loadAssets } from '../stores/config.js';

const props = defineProps({
  config:   { type: Object, default: () => ({}) },
  assets:   { type: Object, default: () => ({}) },
  archMeta: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['changed']);

const selectedId = ref(null);
const isAdding   = ref(false);
const saving     = ref(false);

onMounted(() => { loadAssets().catch(() => {}); });

function select(id) {
  selectedId.value = id;
  isAdding.value   = false;
}

function startNew() {
  selectedId.value = '__new__';
  isAdding.value   = true;
}

function stepSummary(wf) {
  const STEP_LABELS = { generate: 'Generate', upscale: 'Upscale' };
  if (!wf?.steps?.length) return 'No steps';
  return wf.steps.map(s => STEP_LABELS[s.type] ?? s.type).join(' · ');
}

async function setActive() {
  await setActiveWorkflow(selectedId.value);
  emit('changed');
}

async function duplicate() {
  if (!selectedId.value || isAdding.value) return;
  saving.value = true;
  try {
    const wf = props.config.workflows[selectedId.value];
    await saveWorkflow(null, { ...JSON.parse(JSON.stringify(wf)), label: (wf.label || selectedId.value) + ' (copy)' });
    emit('changed');
  } finally {
    saving.value = false;
  }
}

async function del() {
  if (!selectedId.value || isAdding.value) return;
  if (!confirm(`Delete "${props.config.workflows[selectedId.value]?.label || selectedId.value}"?`)) return;
  saving.value = true;
  try {
    await deleteWorkflow(selectedId.value);
    selectedId.value = null;
    emit('changed');
  } finally {
    saving.value = false;
  }
}

async function onSaved() {
  selectedId.value = null;
  isAdding.value   = false;
  emit('changed');
}

async function onDeleted() {
  selectedId.value = null;
  isAdding.value   = false;
  emit('changed');
}
</script>

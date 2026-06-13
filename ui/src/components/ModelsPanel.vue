<template>
  <div class="two-pane">
    <!-- Left: model list -->
    <div class="two-pane-list">
      <div class="two-pane-header">
        <span class="two-pane-header-title">Models</span>
        <button class="primary small" @click="startNew">+ New</button>
      </div>
      <select v-model="archFilter" class="arch-filter">
        <option value="">All architectures</option>
        <option v-for="(meta, arch) in usedArchs" :key="arch" :value="arch">{{ meta.label }}</option>
      </select>
      <div class="two-pane-list-body">
        <div
          v-for="(m, id) in filteredModels"
          :key="id"
          class="list-row"
          :class="{ selected: selectedId === id }"
          @click="select(id)"
        >
          <div class="list-row-name">{{ m.label || id }}</div>
          <div class="list-row-meta">{{ archMeta[m.architecture]?.label || m.architecture || '—' }}</div>
        </div>
        <div v-if="!Object.keys(filteredModels).length" style="font-size:12px;color:var(--muted);padding:8px 4px">
          {{ Object.keys(config.models ?? {}).length ? 'No models match this filter.' : 'No models yet.' }}
        </div>
      </div>
    </div>

    <!-- Right: editor -->
    <div class="two-pane-detail">
      <div class="editor-header">
        <template v-if="selectedId !== null">
          <span class="editor-header-name">{{ isAdding ? 'New model' : (config.models[selectedId]?.label || selectedId) }}</span>
          <button v-if="!isAdding" class="danger small" @click="del" :disabled="saving">Delete</button>
        </template>
      </div>
      <div v-if="selectedId !== null" class="two-pane-detail-body">
        <ModelEditor
          :key="selectedId"
          :model-id="isAdding ? null : selectedId"
          :model="isAdding ? null : config.models[selectedId]"
          :arch-meta="archMeta"
          :assets="assets"
          @saved="onSaved"
          @deleted="onDeleted"
        />
      </div>
      <div v-else class="two-pane-placeholder">Select a model to edit</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import ModelEditor from './ModelEditor.vue';
import { deleteModel, loadAssets } from '../stores/config.js';

const props = defineProps({
  config:   { type: Object, default: () => ({}) },
  assets:   { type: Object, default: () => ({}) },
  archMeta: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['changed']);

const selectedId = ref(null);
const isAdding   = ref(false);
const saving     = ref(false);
const archFilter = ref('');

const usedArchs = computed(() => {
  const archs = new Set(Object.values(props.config.models ?? {}).map(m => m.architecture).filter(Boolean));
  return Object.fromEntries(Object.entries(props.archMeta).filter(([arch]) => archs.has(arch)));
});

const filteredModels = computed(() => {
  const models = props.config.models ?? {};
  if (!archFilter.value) return models;
  return Object.fromEntries(Object.entries(models).filter(([, m]) => m.architecture === archFilter.value));
});

onMounted(() => { loadAssets().catch(() => {}); });

function select(id) {
  selectedId.value = id;
  isAdding.value   = false;
}

function startNew() {
  selectedId.value = '__new__';
  isAdding.value   = true;
}

async function del() {
  if (!selectedId.value || isAdding.value) return;
  if (!confirm(`Delete "${props.config.models[selectedId.value]?.label || selectedId.value}"?`)) return;
  saving.value = true;
  try {
    await deleteModel(selectedId.value);
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

<style scoped>
.arch-filter {
  width: 100%; margin: 6px 0;
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); padding: 6px 8px; font-size: 13px; font-family: inherit;
}
.arch-filter:focus { outline: none; border-color: var(--accent); }
</style>

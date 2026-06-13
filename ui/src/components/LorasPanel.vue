<template>
  <div class="two-pane">
    <!-- Left: lora list -->
    <div class="two-pane-list">
      <div class="two-pane-header">
        <span class="two-pane-header-title">LoRAs</span>
        <button class="secondary small" :disabled="scanning" @click="rescan">
          {{ scanning ? 'Scanning…' : 'Rescan' }}
        </button>
      </div>
      <select v-model="archFilter" class="arch-filter">
        <option value="">All architectures</option>
        <option v-for="(meta, arch) in imageArchs" :key="arch" :value="arch">{{ meta.label }}</option>
        <option value="__unassigned__">Unassigned</option>
      </select>
      <div class="two-pane-list-body">
        <div
          v-for="lora in filteredEntries"
          :key="lora.filename"
          class="list-row"
          :class="{ selected: selectedFilename === lora.filename }"
          @click="selectedFilename = lora.filename"
        >
          <div class="list-row-name">{{ lora.label || lora.filename }}</div>
          <div class="list-row-meta">
            {{ archMeta[lora.architecture]?.label || lora.architecture || 'unassigned' }}
            <span v-if="!lora.architecture" class="lora-flag">hidden from LLM</span>
            <span v-else-if="lora.autoDetected" class="lora-flag lora-flag--auto">auto</span>
          </div>
        </div>
        <div v-if="!filteredEntries.length" style="font-size:12px;color:var(--muted);padding:8px 4px">
          {{ entries.length ? 'No LoRAs match this filter.' : 'No LoRAs found — click Rescan after adding files to ComfyUI\'s loras folder.' }}
        </div>
      </div>
    </div>

    <!-- Right: editor -->
    <div class="two-pane-detail">
      <div class="editor-header">
        <template v-if="selected">
          <span class="editor-header-name">{{ selected.filename }}</span>
          <span v-if="!selected.architecture" class="lora-flag">hidden from LLM</span>
          <span v-else-if="selected.autoDetected" class="lora-flag lora-flag--auto">auto-detected</span>
        </template>
      </div>
      <div v-if="selected" class="two-pane-detail-body">
        <p class="hint">
          LoRAs are matched to the step model's architecture before being offered to the LLM.
          Entries without an architecture are hidden from the LLM until you assign one.
        </p>
        <div class="row">
          <label>Label
            <input type="text" v-model="selected.label">
          </label>
          <label>Architecture
            <select v-model="selected.architecture">
              <option :value="null">— unassigned —</option>
              <option v-for="(meta, arch) in imageArchs" :key="arch" :value="arch">{{ meta.label }}</option>
            </select>
          </label>
          <label>Default weight
            <input type="number" v-model.number="selected.defaultWeight" min="0" max="2" step="0.05">
          </label>
        </div>
        <label>Trigger words <span class="hint">(comma-separated; the LLM is told to include them)</span>
          <input type="text" :value="(selected.triggerWords ?? []).join(', ')" @input="selected.triggerWords = splitWords($event.target.value)">
        </label>
        <label>Description <span class="hint">(shown to the LLM when deciding)</span>
          <input type="text" v-model="selected.description" placeholder="e.g. 8-step turbo — speeds up generation">
        </label>
        <div class="panel-actions">
          <button class="primary" @click="save(selected)">Save</button>
        </div>
      </div>
      <div v-else class="two-pane-placeholder">Select a LoRA to edit</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { loadLoras, scanLoras, saveLora } from '../stores/config.js';

const props = defineProps({
  archMeta: { type: Object, default: () => ({}) },
});

const loras            = ref({});
const scanning         = ref(false);
const archFilter       = ref('');
const selectedFilename = ref(null);

const entries  = computed(() => Object.values(loras.value));
const selected = computed(() => selectedFilename.value ? loras.value[selectedFilename.value] : null);
const imageArchs = computed(() =>
  Object.fromEntries(Object.entries(props.archMeta).filter(([, m]) => !m.videoArch)),
);

const filteredEntries = computed(() => {
  if (!archFilter.value) return entries.value;
  if (archFilter.value === '__unassigned__') return entries.value.filter(l => !l.architecture);
  return entries.value.filter(l => l.architecture === archFilter.value);
});

function splitWords(text) {
  return text.split(',').map(w => w.trim()).filter(Boolean);
}

async function rescan() {
  scanning.value = true;
  try { loras.value = await scanLoras(); }
  catch (err) { alert(`Scan failed: ${err.message}`); }
  finally { scanning.value = false; }
}

async function save(lora) {
  try {
    const saved = await saveLora(lora.filename, {
      label:         lora.label,
      architecture:  lora.architecture,
      triggerWords:  lora.triggerWords ?? [],
      description:   lora.description,
      defaultWeight: lora.defaultWeight,
    });
    loras.value[lora.filename] = saved;
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
}

onMounted(async () => {
  loras.value = await loadLoras().catch(() => ({}));
  if (!Object.keys(loras.value).length) await rescan().catch(() => {});
});
</script>

<style scoped>
.arch-filter { width: 100%; margin: 6px 0; }
.lora-flag {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: color-mix(in srgb, var(--muted, #888) 25%, transparent);
}
.lora-flag--auto { background: color-mix(in srgb, var(--accent, #7c3aed) 20%, transparent); }
</style>

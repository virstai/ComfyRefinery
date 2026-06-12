<template>
  <div style="flex:1;overflow-y:auto;padding:20px 24px">
    <div class="panel-header">
      <h2>LoRAs</h2>
      <button class="secondary" :disabled="scanning" @click="rescan">
        {{ scanning ? 'Scanning…' : 'Rescan ComfyUI' }}
      </button>
    </div>
    <p class="hint">
      LoRAs are matched to the step model's architecture before being offered to the LLM.
      Entries without an architecture are hidden from the LLM until you assign one.
    </p>

    <p v-if="!entries.length" class="hint">No LoRAs found — click Rescan after adding files to ComfyUI's loras folder.</p>

    <div v-for="lora in entries" :key="lora.filename" class="lora-row" :class="{ 'lora-row--unassigned': !lora.architecture }">
      <div class="lora-row-head">
        <strong>{{ lora.filename }}</strong>
        <span v-if="!lora.architecture" class="lora-flag">hidden from LLM</span>
        <span v-else-if="lora.autoDetected" class="lora-flag lora-flag--auto">auto-detected</span>
      </div>
      <div class="row">
        <label>Label
          <input type="text" v-model="lora.label">
        </label>
        <label>Architecture
          <select v-model="lora.architecture">
            <option :value="null">— unassigned —</option>
            <option v-for="(meta, arch) in imageArchs" :key="arch" :value="arch">{{ meta.label }}</option>
          </select>
        </label>
        <label>Default weight
          <input type="number" v-model.number="lora.defaultWeight" min="0" max="2" step="0.05">
        </label>
      </div>
      <label>Trigger words <span class="hint">(comma-separated; the LLM is told to include them)</span>
        <input type="text" :value="(lora.triggerWords ?? []).join(', ')" @input="lora.triggerWords = splitWords($event.target.value)">
      </label>
      <label>Description <span class="hint">(shown to the LLM when deciding)</span>
        <input type="text" v-model="lora.description" placeholder="e.g. 8-step turbo — speeds up generation">
      </label>
      <div class="panel-actions">
        <button class="small primary" @click="save(lora)">Save</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { loadLoras, scanLoras, saveLora } from '../stores/config.js';

const props = defineProps({
  archMeta: { type: Object, default: () => ({}) },
});

const loras    = ref({});
const scanning = ref(false);

const entries = computed(() => Object.values(loras.value));
const imageArchs = computed(() =>
  Object.fromEntries(Object.entries(props.archMeta).filter(([, m]) => !m.videoArch)),
);

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
.lora-row {
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.lora-row--unassigned { border-style: dashed; opacity: 0.85; }
.lora-row-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.lora-flag {
  font-size: 10px; padding: 1px 6px; border-radius: 8px;
  background: color-mix(in srgb, var(--muted, #888) 25%, transparent);
}
.lora-flag--auto { background: color-mix(in srgb, var(--accent, #7c3aed) 20%, transparent); }
.panel-header { display: flex; justify-content: space-between; align-items: center; }
</style>

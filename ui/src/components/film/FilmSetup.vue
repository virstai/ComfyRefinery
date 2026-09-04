<template>
  <div class="film-setup">
    <p class="hint" style="margin:0 0 10px">Independent of workflows — the project pins a model and its own generation settings.</p>
    <div class="row">
      <label>Video model
        <select :value="project.modelId" :disabled="modelLocked" @change="save({ modelId: $event.target.value })">
          <option v-for="m in filmModels" :key="m.id" :value="m.id">{{ m.label || m.id }} ({{ m.architecture }})</option>
        </select>
      </label>
      <label style="flex:1.4">Format
        <select :value="formatKey" @change="saveFormat($event.target.value)">
          <option v-if="!currentPreset" :value="formatKey">Custom · {{ project.format.width }}×{{ project.format.height }}</option>
          <optgroup v-for="group in formatGroups" :key="group.name" :label="group.name">
            <option v-for="f in group.formats" :key="keyOf(f)" :value="keyOf(f)">{{ f.label }}</option>
          </optgroup>
        </select>
      </label>
      <label>FPS<input type="number" :value="project.format.fps" @change="saveFps($event.target.value)"></label>
    </div>
    <p class="hint" style="margin-top:-6px;margin-bottom:10px">
      <template v-if="modelLocked">The model is locked once a take is approved — the film is built on it. </template>
      Sizes are the ones this model type supports. Reframe any time: clips already made keep their size; export re-encodes if sizes differ.
    </p>
    <div class="row">
      <label>Default frames<input type="number" :value="project.gen?.frames" :placeholder="String(defaults.frames ?? '')" @change="saveGen('frames', $event.target.value)"></label>
      <label>Steps<input type="number" :value="project.gen?.steps ?? ''" :placeholder="`${defaults.steps ?? 'arch default'}`" @change="saveGen('steps', $event.target.value)"></label>
      <label>Sampler<input :value="project.gen?.sampler ?? ''" :placeholder="defaults.sampler ?? ''" @change="saveGen('sampler', $event.target.value)"></label>
      <label v-if="archMeta.referenceToVideo">Reference image size
        <select :value="project.gen?.refImageSize ?? 'match'" @change="saveGen('refImageSize', $event.target.value)">
          <option value="match">match (faster)</option>
          <option value="max">max (sharper refs, slower)</option>
        </select>
      </label>
    </div>
    <div v-if="model" class="film-setup-model">
      <div class="hint">Model files (edit on the Models page):</div>
      <div v-for="(v, k) in loaderFields" :key="k" class="film-kv"><span>{{ k }}</span><code>{{ v }}</code></div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { configState } from '../../stores/config.js';
import { filmState, updateProject } from '../../stores/film.js';

const props = defineProps({ project: { type: Object, required: true } });

const filmModels = computed(() =>
  Object.values(configState.config.models ?? {}).filter(m => configState.archMeta[m.architecture]?.film));
const model     = computed(() => configState.config.models?.[props.project.modelId]);
const archMeta  = computed(() => configState.archMeta[model.value?.architecture] ?? {});
const defaults  = computed(() => archMeta.value.defaults ?? {});
const modelLocked = computed(() => props.project.segments.some(s => s.status === 'approved' && s.approvedTakeId));

const SKIP = new Set(['id', 'label', 'architecture', 'devices']);
const loaderFields = computed(() => Object.fromEntries(
  Object.entries(model.value ?? {}).filter(([k, v]) => !SKIP.has(k) && v && typeof v !== 'object')));

async function save(patch) {
  try { await updateProject(patch); }
  catch (err) { filmState.status = `Error: ${err.message}`; }
}
// Format presets come from the arch (ARCH_META[arch].filmFormats or derived from its
// defaults) — the user picks an orientation + aspect ratio rather than typing pixels.
const ORIENTATIONS = [['landscape', 'Landscape'], ['portrait', 'Portrait'], ['square', 'Square']];
const keyOf = f => `${f.width}x${f.height}`;
const formatKey     = computed(() => keyOf(props.project.format));
const formatPresets = computed(() => archMeta.value.filmFormats ?? []);
const currentPreset = computed(() => formatPresets.value.find(f => keyOf(f) === formatKey.value) ?? null);
const formatGroups  = computed(() => ORIENTATIONS
  .map(([id, name]) => ({ name, formats: formatPresets.value.filter(f => f.orientation === id) }))
  .filter(g => g.formats.length));

function saveFormat(key) {
  const f = formatPresets.value.find(p => keyOf(p) === key);
  if (!f) return;
  save({ format: { ...props.project.format, width: f.width, height: f.height } });
}
function saveFps(value) {
  const n = Number(value);
  if (!n) return;
  save({ format: { ...props.project.format, fps: n } });
}
function saveGen(key, value) {
  const gen = { ...(props.project.gen ?? {}) };
  if (value === '' || value == null) gen[key] = null;
  else gen[key] = ['frames', 'steps'].includes(key) ? Number(value) : value;
  save({ gen });
}
</script>

<style scoped>
.film-setup { padding: 0 0 4px; }
.film-setup-model { margin-bottom: 8px; }
.film-kv { display: flex; gap: 10px; font-size: 11px; color: var(--muted); }
.film-kv span { min-width: 140px; }
.film-kv code { color: var(--text); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

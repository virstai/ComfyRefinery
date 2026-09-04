<template>
  <div class="film-project">
    <!-- Header -->
    <div class="film-head">
      <input class="film-title" :value="project.title" placeholder="Title" @change="save({ title: $event.target.value.trim() })">
      <span class="film-chip" :title="modelLabel">{{ formatLabel }} · {{ project.format.fps }} fps · {{ modelLabel }}</span>
      <span class="film-status" :class="{ 'is-error': filmState.status.startsWith('Error') }">{{ filmState.status }}</span>
      <button class="secondary small" @click="drawer = 'setup'">⚙ Setup</button>
      <button class="secondary small" @click="drawer = 'refs'">▦ References <span class="film-count">{{ project.refs.length }}</span></button>
      <button class="secondary small" :disabled="!canExport || exporting" title="Stitch the approved takes into one file" @click="doExport">⤓ Export</button>
      <button class="danger small" :disabled="filmState.running" @click="del">Delete</button>
    </div>

    <!-- Stage: preview + inspector -->
    <div class="film-stage">
      <PreviewPane :segment="segment" />
      <div class="film-inspector">
        <template v-if="segment">
          <TakeInspector v-if="inspectedTake" :key="inspectedTake.id" :take="inspectedTake" :segment="segment" :project="project" />
          <SegmentEditor :key="segment.id" :segment="segment" :project="project" />
        </template>
        <div v-else class="film-inspector-empty">
          <p class="hint">No segment yet. Add one on the timeline below, then set how it starts and describe what happens.</p>
          <label>Logline
            <textarea class="steering-input" rows="3" :value="project.logline" placeholder="What is this film about? Always in the prompt writer's context." @change="save({ logline: $event.target.value.trim() })"></textarea>
          </label>
        </div>
      </div>
    </div>

    <!-- Timeline -->
    <SegmentTimeline
      :segments="project.segments"
      :selected-id="filmState.segmentId"
      :running-id="filmState.running ? filmState.runSegmentId : null"
      @select="selectSegment"
      @add="addSegment"
    />

    <!-- Drawers -->
    <FilmDrawer v-if="drawer === 'setup'" title="Project setup" width="520px" @close="drawer = null">
      <FilmSetup :project="project" />
      <label style="margin-top:12px">Logline
        <textarea class="steering-input" rows="3" :value="project.logline" placeholder="What is this film about? Always in the prompt writer's context." @change="save({ logline: $event.target.value.trim() })"></textarea>
      </label>
    </FilmDrawer>
    <FilmDrawer v-if="drawer === 'refs'" title="References" width="460px" @close="drawer = null">
      <RefBank :project="project" />
    </FilmDrawer>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import FilmSetup       from './FilmSetup.vue';
import FilmDrawer      from './FilmDrawer.vue';
import PreviewPane     from './PreviewPane.vue';
import TakeInspector   from './TakeInspector.vue';
import SegmentTimeline from './SegmentTimeline.vue';
import SegmentEditor   from './SegmentEditor.vue';
import RefBank         from './RefBank.vue';
import { configState } from '../../stores/config.js';
import { filmState, updateProject, deleteProject, addSegment, selectSegment, exportProject, currentSegment } from '../../stores/film.js';

const emit = defineEmits(['deleted']);

const project   = computed(() => filmState.project);
const segment   = computed(() => currentSegment());
const drawer    = ref(filmState.project?.segments?.length ? null : 'setup');
const exporting = ref(false);

const modelLabel    = computed(() => configState.config.models?.[project.value.modelId]?.label ?? project.value.modelId);
// "16:9 · 1344×768" when the format matches one of the arch's presets, else plain pixels
const formatLabel   = computed(() => {
  const { width, height } = project.value.format;
  const arch = configState.config.models?.[project.value.modelId]?.architecture;
  const preset = (configState.archMeta[arch]?.filmFormats ?? []).find(f => f.width === width && f.height === height);
  return preset ? `${preset.aspect} · ${width}×${height}` : `${width}×${height}`;
});
const canExport     = computed(() => project.value.segments.some(s => s.status === 'approved' && s.approvedTakeId));
const inspectedTake = computed(() => segment.value?.takes?.find(t => t.id === filmState.preview.takeId) ?? null);

async function save(patch) {
  try { await updateProject(patch); }
  catch (err) { filmState.status = `Error: ${err.message}`; }
}
async function del() {
  if (!confirm(`Delete project "${project.value.title}" and all its clips?`)) return;
  try { await deleteProject(project.value.id); emit('deleted'); }
  catch (err) { alert(`Delete failed: ${err.message}`); }
}
async function doExport() {
  exporting.value = true;
  try { await exportProject(); }
  catch (err) { filmState.status = `Error: ${err.message}`; }
  finally { exporting.value = false; }
}
</script>

<style scoped>
.film-project { position: relative; flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; min-width: 0; }
.film-head {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border);
  background: var(--surface); flex-shrink: 0; min-height: 44px;
}
.film-title {
  min-width: 140px; width: 220px; background: transparent; border: 1px solid transparent; border-radius: 4px;
  color: var(--text); font-size: 15px; font-weight: 600; padding: 4px 6px; font-family: inherit;
}
.film-title:hover, .film-title:focus { border-color: var(--border); outline: none; background: var(--bg); }
.film-chip { font-size: 11px; color: var(--muted); background: var(--surface2); padding: 2px 8px; border-radius: 8px; white-space: nowrap; }
.film-status { flex: 1; min-width: 0; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; padding-right: 6px; }
.film-status.is-error { color: var(--reject); }
.film-count { font-size: 10px; background: var(--surface2); border-radius: 8px; padding: 0 6px; margin-left: 4px; }
.film-stage { flex: 1; min-height: 0; display: flex; gap: 12px; padding: 10px 12px 6px; }
.film-inspector { width: 390px; flex-shrink: 0; overflow-y: auto; padding-right: 4px; min-height: 0; }
.film-inspector-empty { padding: 8px 2px; }
</style>

<template>
  <div class="two-pane">
    <!-- Left: project list (collapses to a rail once a project is open) -->
    <div v-if="listCollapsed" class="film-rail" title="Show projects" @click="listCollapsed = false">
      <span class="film-rail-arrow">›</span>
      <span class="film-rail-text">Projects</span>
    </div>
    <div v-else class="two-pane-list film-list">
      <div class="two-pane-header">
        <span class="two-pane-header-title">Film projects</span>
        <button class="primary small" :disabled="!canCreate" @click="startNew">+ New</button>
        <button v-if="filmState.project" class="secondary small" title="Hide the list" @click="listCollapsed = true">‹</button>
      </div>
      <div class="two-pane-list-body">
        <div
          v-for="p in filmState.projects"
          :key="p.id"
          class="list-row"
          :class="{ selected: filmState.project?.id === p.id && !isAdding }"
          @click="open(p.id)"
        >
          <div class="list-row-name">{{ p.title || p.id }}</div>
          <div class="list-row-meta">{{ p.approvedCount ?? 0 }}/{{ p.segmentCount ?? 0 }} segments approved · {{ modelLabel(p.modelId) }}</div>
        </div>
        <div v-if="!filmState.projects.length" style="font-size:12px;color:var(--muted);padding:8px 4px">
          No projects yet.
        </div>
      </div>
    </div>

    <!-- Right: project workspace -->
    <div class="two-pane-detail">
      <div v-if="filmState.ffmpeg && !filmState.ffmpeg.available" class="film-gate">
        <strong>ffmpeg not found on the server.</strong>
        The Film view needs it for last-frame capture, reference captures and export. Install ffmpeg (and ffprobe) or set
        <code>FFMPEG_PATH</code> / <code>FFPROBE_PATH</code>, then check the System page.
        <span v-if="filmState.ffmpeg.error" class="hint" style="display:block;margin-top:4px">{{ filmState.ffmpeg.error }}</span>
      </div>
      <div v-else-if="!filmState.ffmpeg" class="two-pane-placeholder">Checking media tools…</div>

      <template v-if="filmState.ffmpeg?.available">
        <div v-if="isAdding" class="two-pane-detail-body">
          <div class="editor-header"><span class="editor-header-name">New film project</span></div>
          <label>Title<input v-model="newTitle" placeholder="Working title" @keyup.enter="create"></label>
          <label>Video model
            <select v-model="newModelId">
              <option v-for="m in filmModels" :key="m.id" :value="m.id">{{ m.label || m.id }} ({{ m.architecture }})</option>
            </select>
          </label>
          <p v-if="!filmModels.length" class="hint">No Film-capable video model configured. Add a MiniMax H3 model on the Models page first.</p>
          <label>Logline (optional)<textarea v-model="newLogline" rows="2" placeholder="One or two sentences on what the film is about"></textarea></label>
          <div class="row" style="flex:0">
            <button class="primary" :disabled="creating || !newTitle.trim() || !newModelId" @click="create">Create</button>
            <button class="secondary" :disabled="creating" @click="isAdding = false">Cancel</button>
          </div>
          <p v-if="createError" class="hint" style="color:var(--reject)">{{ createError }}</p>
        </div>
        <FilmProject v-else-if="filmState.project" :key="filmState.project.id" @deleted="onDeleted" />
        <div v-else class="two-pane-placeholder">Select a project or create a new one</div>
      </template>
      <Lightbox />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import FilmProject from './FilmProject.vue';
import Lightbox    from '../Lightbox.vue';
import { configState } from '../../stores/config.js';
import { filmState, loadFfmpeg, loadProjects, createProject, openProject } from '../../stores/film.js';

const isAdding   = ref(false);
const listCollapsed = ref(!!filmState.project);
// A project opened from the URL (or elsewhere) collapses the list too
watch(() => filmState.project?.id, (id, old) => { if (id && !old) listCollapsed.value = true; });
const newTitle   = ref('');
const newModelId = ref('');
const newLogline = ref('');
const creating   = ref(false);
const createError = ref('');

const filmModels = computed(() =>
  Object.values(configState.config.models ?? {}).filter(m => configState.archMeta[m.architecture]?.film));
const canCreate = computed(() => filmState.ffmpeg?.available && filmModels.value.length > 0);

function modelLabel(id) {
  return configState.config.models?.[id]?.label ?? id ?? '—';
}

onMounted(async () => {
  await loadFfmpeg();
  try { await loadProjects(); } catch (err) { console.warn('Could not load projects:', err.message); }
});

function startNew() {
  isAdding.value = true;
  createError.value = '';
  if (!newModelId.value) newModelId.value = filmModels.value[0]?.id ?? '';
}

async function create() {
  if (!newTitle.value.trim() || !newModelId.value) return;
  creating.value = true;
  createError.value = '';
  try {
    await createProject({ title: newTitle.value.trim(), modelId: newModelId.value, logline: newLogline.value.trim() });
    isAdding.value = false; listCollapsed.value = true;
    newTitle.value = ''; newLogline.value = '';
  } catch (err) {
    createError.value = err.message;
  } finally {
    creating.value = false;
  }
}

async function open(id) {
  isAdding.value = false;
  if (filmState.running && filmState.project?.id !== id) {
    if (!confirm('A take is running in the open project. Switching projects hides its progress (it keeps running). Continue?')) return;
  }
  try { await openProject(id); listCollapsed.value = true; } catch (err) { alert(`Could not open project: ${err.message}`); }
}

function onDeleted() {
  isAdding.value = false;
  listCollapsed.value = false;
}
</script>

<style scoped>
.film-gate {
  margin: 16px; padding: 12px 14px; font-size: 13px; line-height: 1.5;
  border: 1px solid color-mix(in srgb, var(--reject) 40%, var(--border)); border-radius: var(--radius);
  background: color-mix(in srgb, var(--reject) 8%, transparent);
}
.film-gate code { font-size: 12px; }
.film-list { width: 220px; }
.film-list .two-pane-header { padding: 0 10px; gap: 6px; }
.film-list .two-pane-header-title { white-space: nowrap; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.film-rail {
  width: 28px; flex-shrink: 0; border-right: 1px solid var(--border); background: var(--surface);
  display: flex; flex-direction: column; align-items: center; gap: 6px; padding-top: 12px; cursor: pointer; color: var(--muted);
}
.film-rail:hover { color: var(--accent); }
.film-rail-arrow { font-size: 16px; line-height: 1; }
.film-rail-text { writing-mode: vertical-rl; font-size: 11px; letter-spacing: .5px; }
</style>

<template>
  <div class="ref-bank" :class="{ drag: dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
    <div class="ref-bank-head">
      <span class="hint" style="margin-right:auto">{{ project.refs.length }} entr{{ project.refs.length === 1 ? 'y' : 'ies' }}</span>
      <button class="secondary small" @click="openUpload(null)">+ Upload</button>
      <button class="secondary small" @click="pickerOpen = true">+ From session</button>
      <button class="secondary small" title="Render a still with any image model (e.g. anima) straight into the bank" @click="genOpen = !genOpen">✨ Generate</button>
      <button class="secondary small" title="Create a named, empty entry (a character, place…) to fill with images or audio later" @click="showNew = !showNew">+ Blank entry</button>
    </div>
    <ImageGenPanel v-if="genOpen" :project="project" @close="genOpen = false" />
    <input ref="fileInput" type="file" multiple accept="image/*,audio/*" style="display:none" @change="onFileInput">

    <div v-if="showNew || pendingFiles || pendingPick" class="ref-new">
      <div class="hint">{{ pendingFiles ? `Add ${pendingFiles.length} file(s) to…` : pendingPick ? 'Add the picked image to…' : 'New entry' }}</div>
      <select v-if="pendingFiles || pendingPick" v-model="pendingTarget" style="margin:6px 0">
        <option value="__new">New entry…</option>
        <option v-for="r in project.refs" :key="r.id" :value="r.id">{{ r.name }} ({{ r.kind }})</option>
      </select>
      <RefEntryForm v-if="pendingTarget === '__new'" v-model="draft" />
      <div class="hr-actions">
        <button class="primary small" :disabled="busy || (pendingTarget === '__new' && !draft.name.trim())" @click="commitPending">{{ pendingFiles || pendingPick ? 'Add' : 'Create' }}</button>
        <button class="secondary small" :disabled="busy" @click="cancelPending">Cancel</button>
      </div>
    </div>

    <div class="ref-bank-body">
      <div v-if="!project.refs.length" class="hint" style="padding:6px 0">The bank holds what must stay consistent across shots: characters, places, props, a style, voices — and scene starts. Add images by upload, drop, <b>✨ Generate</b> (any image model, e.g. anima), or from a Generate session; capture frames and audio from takes once you have some.</div>
      <div v-for="r in project.refs" :key="r.id" class="ref-entry">
        <div class="ref-entry-head">
          <span class="chip">{{ r.kind }}</span>
          <input class="ref-entry-name" :value="r.name" @change="edit(r, { name: $event.target.value.trim() })">
          <button class="icon-btn small" :title="r.pinned ? 'Pinned: pre-selected on new segments' : 'Pin: pre-select on new segments'" :class="{ pinned: r.pinned }" @click="edit(r, { pinned: !r.pinned })">📌</button>
          <button class="icon-btn small" title="Remove entry" @click="remove(r)">✕</button>
        </div>
        <textarea class="ref-entry-desc" rows="2" :value="r.description" placeholder="description the prompt writer reuses" @change="edit(r, { description: $event.target.value.trim() })"></textarea>
        <div class="ref-media">
          <div v-for="m in r.media" :key="m.id" class="ref-media-item" :title="mediaTitle(m)">
            <img v-if="m.type === 'image'" :src="mediaUrl(m.file)" class="ref-img-thumb zoomable" :class="{ previewed: filmState.preview.mediaId === m.id }" alt="" title="Click to preview · double-click to enlarge" @click="previewImage(mediaUrl(m.file), `${r.name} (${r.kind}) — ${mediaTitle(m)}`, { refId: r.id, mediaId: m.id })" @dblclick="openLightbox(mediaUrl(m.file), `${r.name} (${r.kind}) — ${mediaTitle(m)}`)">
            <audio v-else :src="mediaUrl(m.file)" controls class="ref-audio"></audio>
            <span v-if="m.source?.type?.startsWith('clip')" class="ref-media-cap">from take</span>
            <span v-else-if="m.source?.type === 'generate'" class="ref-media-cap">generated</span>
            <button class="ref-media-remove" title="Remove" @click="removeMedia(r, m)">×</button>
          </div>
          <button class="ref-add-tile" title="Add files to this entry" @click="openUpload(r.id)">+</button>
        </div>
      </div>
    </div>

    <SessionImagePicker v-if="pickerOpen" @pick="onPick" @close="pickerOpen = false" />
  </div>
</template>

<script setup>
import { ref } from 'vue';
import RefEntryForm       from './RefEntryForm.vue';
import SessionImagePicker from './SessionImagePicker.vue';
import ImageGenPanel      from './ImageGenPanel.vue';
import { filmState, mediaUrl, uploadRefFiles, addRefFromSession, createRef, updateRef, removeRef, removeRefMedia, previewImage } from '../../stores/film.js';
import { openLightbox } from '../../stores/lightbox.js';

const props = defineProps({ project: { type: Object, required: true } });

const fileInput  = ref(null);
const dragging   = ref(false);
const busy       = ref(false);
const showNew    = ref(false);
const pickerOpen = ref(false);
const genOpen    = ref(false);
const pendingFiles  = ref(null);
const pendingPick   = ref(null);
const pendingTarget = ref('__new');
const draft = ref({ kind: 'character', name: '', description: '' });

function openUpload(refId) {
  pendingTarget.value = refId ?? '__new';
  fileInput.value?.click();
}
function onFileInput(e) {
  const files = Array.from(e.target.files ?? []);
  e.target.value = '';
  if (!files.length) return;
  if (pendingTarget.value !== '__new') return commitFiles(files, { refId: pendingTarget.value });
  pendingFiles.value = files;
}
function onDrop(e) {
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  pendingTarget.value = '__new';
  pendingFiles.value = files;
}
function onPick(pick) {
  pickerOpen.value = false;
  pendingTarget.value = '__new';
  pendingPick.value = pick;
}

function targetSpec() {
  return pendingTarget.value === '__new'
    ? { kind: draft.value.kind, name: draft.value.name.trim(), description: draft.value.description.trim() }
    : { refId: pendingTarget.value };
}

async function commitFiles(files, target) {
  busy.value = true;
  try { await uploadRefFiles(files, target); filmState.status = `Added ${files.length} file(s)`; }
  catch (err) { alert(`Upload failed: ${err.message}`); }
  finally { busy.value = false; }
}

async function commitPending() {
  const target = targetSpec();
  busy.value = true;
  try {
    if (pendingFiles.value) await uploadRefFiles(pendingFiles.value, target);
    else if (pendingPick.value) await addRefFromSession(pendingPick.value, target);
    else await createRef(target);
    cancelPending();
  } catch (err) {
    alert(`Failed: ${err.message}`);
  } finally {
    busy.value = false;
  }
}
function cancelPending() {
  pendingFiles.value = null; pendingPick.value = null; showNew.value = false;
  pendingTarget.value = '__new';
  draft.value = { kind: 'character', name: '', description: '' };
}

async function edit(r, patch) {
  try { await updateRef(r.id, patch); } catch (err) { filmState.status = `Error: ${err.message}`; }
}
async function remove(r) {
  if (!confirm(`Remove reference "${r.name}"? Segments that use it will drop it.`)) return;
  try { await removeRef(r.id); } catch (err) { alert(`Failed: ${err.message}`); }
}
async function removeMedia(r, m) {
  if (!confirm('Remove this file from the entry?')) return;
  try { await removeRefMedia(r.id, m.id); } catch (err) { alert(`Failed: ${err.message}`); }
}
function mediaTitle(m) {
  const s = m.source ?? {};
  if (s.type === 'clip-frame') return `frame at ${s.t}s of a take`;
  if (s.type === 'clip-audio') return `audio ${s.from}–${s.to}s of a take`;
  if (s.type === 'session') return 'from a Generate session';
  if (s.type === 'generate') return `generated with ${s.modelId}: ${s.prompt}`;
  return 'uploaded';
}
</script>

<style scoped>
.ref-bank { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.ref-bank.drag { outline: 2px dashed var(--accent); outline-offset: -4px; }
.ref-bank-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 4px 0 8px; }
.ref-bank-title { font-size: 13px; font-weight: 600; margin-right: auto; }
.ref-bank-body { flex: 1; overflow-y: auto; padding-bottom: 24px; min-height: 0; }
.ref-new { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; margin-bottom: 8px; }
.ref-entry { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; margin-bottom: 8px; background: var(--surface); }
.ref-entry-head { display: flex; align-items: center; gap: 6px; }
.ref-entry-head .chip { font-size: 10px; }
.ref-entry-name { flex: 1; min-width: 0; background: transparent; border: 1px solid transparent; color: var(--text); font-size: 13px; font-weight: 600; padding: 2px 4px; border-radius: 4px; font-family: inherit; }
.ref-entry-name:hover, .ref-entry-name:focus { border-color: var(--border); background: var(--bg); outline: none; }
.icon-btn.small { padding: 2px 6px; font-size: 12px; }
.icon-btn.pinned { color: var(--accent); border-color: var(--accent); }
.ref-entry-desc { width: 100%; margin-top: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 12px; padding: 4px 6px; font-family: inherit; resize: vertical; }
.ref-entry-desc:focus { outline: none; border-color: var(--accent); }
.ref-media { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ref-media-item { position: relative; }
.ref-img-thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border); display: block; }
.zoomable { cursor: zoom-in; }
.zoomable:hover { border-color: var(--accent); }
.ref-img-thumb.previewed { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ref-audio { width: 200px; height: 32px; }
.ref-media-cap { position: absolute; left: 2px; bottom: 2px; font-size: 9px; background: rgba(0,0,0,.6); color: #fff; padding: 0 4px; border-radius: 3px; }
.ref-media-remove { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; padding: 0; border-radius: 50%; background: var(--surface2); color: var(--muted); font-size: 12px; line-height: 18px; border: 1px solid var(--border); }
.ref-media-remove:hover { color: var(--reject); border-color: var(--reject); }
.ref-add-tile { width: 64px; height: 64px; border: 1px dashed var(--border); border-radius: 4px; background: transparent; color: var(--muted); font-size: 20px; }
.ref-add-tile:hover { border-color: var(--accent); color: var(--accent); }
</style>

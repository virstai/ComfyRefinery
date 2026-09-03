<template>
  <div class="seg-editor">
    <div class="seg-editor-head">
      <span class="seg-editor-title">Segment {{ segment.index + 1 }}</span>
      <span class="sess-status" :class="statusClass">{{ isRunning ? 'running' : segment.status }}</span>
      <button v-if="isLast && !segment.takes?.length && !isRunning" class="danger small" style="margin-left:auto" @click="del">Remove</button>
    </div>

    <div v-if="segment.status === 'stale'" class="seg-banner">
      The start frame changed since this segment's takes were made. Run a new take to bring it up to date.
    </div>

    <!-- Start mode -->
    <div class="seg-field">
      <div class="seg-label">Start</div>
      <div class="seg-modes">
        <label class="checkbox-label"><input type="radio" value="continue" :checked="mode === 'continue'" :disabled="isRunning" @change="setMode('continue')"> Continue</label>
        <label class="checkbox-label"><input type="radio" value="cut" :checked="mode === 'cut'" :disabled="isRunning" @change="setMode('cut')"> Cut</label>
      </div>
      <p class="hint">
        <template v-if="mode === 'continue'">Pixel-continuous: the clip starts on a given frame — the previous approved take's last frame, or an image you pick or generate (e.g. an anima still for a new scene). Image references only inform the prompt; voices reset each clip.</template>
        <template v-else>A new shot in the same world: character, place and style images plus voice clips go into the generation itself. Not pixel-continuous with the previous clip.</template>
      </p>
      <div v-if="mode === 'continue'" class="seg-start">
        <label style="margin:0;flex:1">Start frame
          <select :value="startImageKey" :disabled="isRunning" @change="setStartImage($event.target.value)">
            <option value="">{{ prev ? `last frame of segment ${prev.segment.index + 1}'s approved take (default)` : '— pick a bank image, or generate one —' }}</option>
            <option v-for="o in bankImages" :key="o.key" :value="o.key">{{ o.label }}</option>
          </select>
        </label>
        <img v-if="startImageFile" :src="mediaUrl(startImageFile)" class="seg-start-img zoomable" alt="" title="Click to preview · double-click to enlarge" @click="previewImage(mediaUrl(startImageFile), `Segment ${segment.index + 1} · start frame`)" @dblclick="openLightbox(mediaUrl(startImageFile), 'Start frame')">
        <img v-else-if="prev?.take?.lastFrame" :src="mediaUrl(prev.take.lastFrame)" class="seg-start-img zoomable" alt="" title="Click to preview · double-click to enlarge" @click="previewImage(mediaUrl(prev.take.lastFrame), `Segment ${segment.index + 1} · starts from the last frame of segment ${prev.segment.index + 1}`)" @dblclick="openLightbox(mediaUrl(prev.take.lastFrame), `Last frame of segment ${prev.segment.index + 1}`)">
        <button class="secondary small" :disabled="isRunning" title="Render a still with an image model (e.g. anima) and use it as this segment's first frame" @click="genOpen = !genOpen">✨ Generate start image</button>
      </div>
      <ImageGenPanel v-if="mode === 'continue' && genOpen" :project="project" :segment="segment" @close="genOpen = false" />
      <label v-if="mode === 'cut' && prev" class="checkbox-label" style="margin-top:6px">
        <input type="checkbox" :checked="!!segment.start?.includePrevTail" :disabled="isRunning" @change="setIncludeTail($event.target.checked)">
        include the previous take's tail as &lt;Video 1&gt; (motion and voice continuity)
      </label>
      <p v-if="swapHint" class="hint" style="color:var(--warning, #d97706)">{{ swapHint }}</p>
    </div>

    <!-- References -->
    <div class="seg-field">
      <div class="seg-label">References <span class="hint">({{ segment.refIds?.length ?? 0 }} selected)</span></div>
      <div v-if="!project.refs.length" class="hint">No references yet — add some in the bank on the right.</div>
      <div class="seg-refs">
        <label v-for="r in project.refs" :key="r.id" class="checkbox-label seg-ref" :class="{ disabled: refDisabled(r) }" :title="refTitle(r)">
          <input type="checkbox" :checked="segment.refIds?.includes(r.id)" :disabled="isRunning || refDisabled(r)" @change="toggleRef(r.id, $event.target.checked)">
          <span class="chip">{{ r.kind }}</span>{{ r.name }}<span v-if="r.pinned" title="pinned"> 📌</span>
        </label>
      </div>
    </div>

    <!-- LoRAs -->
    <div v-if="archCaps.lora" class="seg-field">
      <div class="seg-label">LoRAs <span class="hint">(this segment only — scene, style or motion LoRAs; the model's turbo LoRA stays on)</span></div>
      <div v-for="(l, li) in loraRows" :key="li" class="row" style="margin-bottom:6px">
        <label style="flex:3">LoRA
          <select :value="l.name" :disabled="isRunning" @change="setLora(li, { name: $event.target.value })">
            <option value="">— pick a file —</option>
            <optgroup v-if="taggedLoras.length" :label="`Tagged ${archLabel}`">
              <option v-for="lr in taggedLoras" :key="lr.filename" :value="lr.filename">{{ lr.label }}{{ lr.label !== lr.filename ? ` (${lr.filename})` : '' }}</option>
            </optgroup>
            <optgroup v-if="otherLoras.length" label="All LoRA files in ComfyUI">
              <option v-for="f in otherLoras" :key="f" :value="f">{{ f }}</option>
            </optgroup>
            <option v-if="l.name && !allLoraFiles.includes(l.name)" :value="l.name">{{ l.name }} (not found)</option>
          </select>
        </label>
        <label style="flex:1">Weight<input type="number" step="0.05" :value="l.weight" :disabled="isRunning" @change="setLora(li, { weight: Number($event.target.value) || 1 })"></label>
        <button class="danger small" style="align-self:flex-end" :disabled="isRunning" title="Remove" @click="removeLora(li)">✕</button>
      </div>
      <button class="secondary small" :disabled="isRunning" @click="addLora">+ Add LoRA</button>
      <p class="hint">{{ taggedLoras.length ? `Files tagged ${archLabel} (System page or LoRAs page) are listed first; every other LoRA file ComfyUI has follows.` : `Nothing is tagged ${archLabel} yet (System page file tags or the LoRAs page), so every LoRA file ComfyUI has is listed — tag the ones made for this model to keep them on top.` }} Rows without a file are not saved.</p>
    </div>

    <label>What happens next
      <textarea class="steering-input" rows="3" :value="segment.intent" :disabled="isRunning" placeholder="Describe the action, in your own words. The LLM turns it into the model's prompt using the script so far." @change="save({ intent: $event.target.value })"></textarea>
    </label>
    <label>Director's notes
      <textarea class="steering-input" rows="2" :value="segment.steering" :disabled="isRunning" placeholder="Framing, camera, pacing, sound (optional)" @change="save({ steering: $event.target.value })"></textarea>
    </label>

    <div class="row">
      <label>Frames<input type="number" :value="segment.frames" :placeholder="String(project.gen?.frames ?? '')" :disabled="isRunning" @change="save({ frames: Number($event.target.value) || null })"></label>
      <label>Seed<input type="number" :value="segment.seed ?? ''" placeholder="random" :disabled="isRunning" @change="save({ seed: $event.target.value === '' ? null : Number($event.target.value) })"></label>
    </div>
    <p class="hint" style="margin-top:-8px;margin-bottom:10px">Frames snap to the model's 17k+5 grid (124 ≈ 5.2 s at 24 fps).</p>

    <!-- Prompt preview -->
    <div class="seg-field">
      <div class="seg-label">Prompt
        <button class="secondary small" :disabled="isRunning || filmState.promptStreaming" @click="write">✎ Write prompt</button>
        <button v-if="hasDraft" class="secondary small" :disabled="isRunning || filmState.promptStreaming" @click="clearDraft">Clear</button>
      </div>
      <textarea
        class="steering-input seg-prompt"
        rows="6"
        :readonly="filmState.promptStreaming"
        :value="filmState.promptStreaming ? filmState.streamingPrompt : (hasDraft ? filmState.promptDraft : '')"
        placeholder="Empty: the LLM writes a fresh prompt when you run. Or write one here yourself."
        @input="onPromptInput($event.target.value)"
      ></textarea>
      <p class="hint">{{ filmState.promptStreaming ? 'Writing…' : hasDraft ? 'This exact text is used by Run. Edit freely; clear it to let the LLM write a fresh one.' : 'No draft — Run will build one from the fields above.' }}</p>
    </div>

    <!-- Run -->
    <div class="seg-run">
      <button v-if="!isRunning" class="primary" :disabled="filmState.running || !canRun" :title="runTitle" @click="run">▶ Run take</button>
      <button v-else class="danger" @click="killRun">■ Stop</button>
      <span class="hint">{{ isRunning ? filmState.status : filmState.running ? 'Another segment is running' : runTitle }}</span>
    </div>
    <div v-if="isRunning" class="seg-progress">
      <div class="progress-bar"><div class="fill" :style="{ width: filmState.progress + '%' }"></div></div>
    </div>

  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue';
import { configState, loadLoras, loadAssets } from '../../stores/config.js';
import ImageGenPanel from './ImageGenPanel.vue';
import { filmState, mediaUrl, previousApprovedTake, saveSegment, deleteSegment, writePrompt, runSegment, killRun, previewImage, setPromptDraft } from '../../stores/film.js';
import { openLightbox } from '../../stores/lightbox.js';

const props = defineProps({
  segment: { type: Object, required: true },
  project: { type: Object, required: true },
});

const isRunning = computed(() => filmState.running && filmState.runSegmentId === props.segment.id);
const isLast    = computed(() => props.project.segments[props.project.segments.length - 1]?.id === props.segment.id);
const mode      = computed(() => props.segment.start?.mode ?? 'cut');
const prev      = computed(() => previousApprovedTake(props.segment, props.project));
const hasDraft  = computed(() => filmState.promptFor === props.segment.id && !!filmState.promptDraft);
const genOpen   = ref(false);

// Per-segment LoRAs (archs with capabilities.lora). Options come from the LoRA
// registry, filtered to this project's model architecture.
const loraRegistry = ref({});
onMounted(async () => {
  loraRegistry.value = await loadLoras().catch(() => ({}));
  if (!configState.assets?.comfyui?.loras?.length) await loadAssets().catch(() => {});
});
const arch      = computed(() => configState.config?.models?.[props.project.modelId]?.architecture);
const archCaps  = computed(() => configState.archMeta?.[arch.value]?.capabilities ?? {});
const archLabel = computed(() => configState.archMeta?.[arch.value]?.label ?? arch.value ?? 'this architecture');
const allLoraFiles = computed(() => configState.assets?.comfyui?.loras ?? []);
// Tagged for this architecture on either page: the LoRAs registry (architecture
// field) or the System page's file → arch tags ("loras:<file>").
const taggedLoras = computed(() => {
  const tags = configState.config?.fileArchTags ?? {};
  const out = new Map();
  for (const l of Object.values(loraRegistry.value)) {
    if (l.architecture === arch.value) out.set(l.filename, { filename: l.filename, label: l.label || l.filename });
  }
  for (const f of allLoraFiles.value) {
    if ((tags[`loras:${f}`] ?? []).includes(arch.value) && !out.has(f)) out.set(f, { filename: f, label: f });
  }
  return [...out.values()];
});
const otherLoras   = computed(() => allLoraFiles.value.filter(f => !taggedLoras.value.some(t => t.filename === f)));

// Rows live locally so a freshly added row (no file yet) can exist; the server
// keeps only rows with a file, so only those are sent.
const loraRows = ref([]);
watch(() => props.segment.loras, list => { loraRows.value = (list ?? []).map(l => ({ ...l })); }, { immediate: true, deep: true });
function saveLoras() { save({ loras: loraRows.value.filter(l => l.name) }); }
function addLora() { loraRows.value.push({ name: '', weight: 1.0 }); }
function removeLora(i) { loraRows.value.splice(i, 1); saveLoras(); }
function setLora(i, patch) { Object.assign(loraRows.value[i], patch); if (loraRows.value[i].name) saveLoras(); }

const statusClass = computed(() => isRunning.value ? 'sess-running'
  : ({ approved: 'sess-complete', stale: 'sess-error' }[props.segment.status] ?? ''));

const bankImages = computed(() => props.project.refs.flatMap(r =>
  (r.media ?? []).filter(m => m.type === 'image').map((m, i) => ({
    key: `${r.id}:${m.id}`, refId: r.id, mediaId: m.id, file: m.file, label: `${r.name} (${r.kind}) #${i + 1}`,
  }))));
const startImageKey  = computed(() => props.segment.start?.startImage ? `${props.segment.start.startImage.refId}:${props.segment.start.startImage.mediaId}` : '');
const startImageFile = computed(() => bankImages.value.find(o => o.key === startImageKey.value)?.file ?? null);

const lastCheckpoint = computed(() => {
  // most recent take anywhere in the project → what is currently loaded in ComfyUI
  const takes = props.project.segments.flatMap(s => s.takes ?? []);
  return takes.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]?.checkpoint ?? null;
});
const swapHint = computed(() => {
  const want = mode.value === 'cut' ? 'ref2va' : 'fl2va';
  return lastCheckpoint.value && lastCheckpoint.value !== want
    ? `Model swap: the last take used the ${lastCheckpoint.value.toUpperCase()} checkpoint; this mode loads ${want.toUpperCase()} (slower first run).`
    : '';
});

const canRun = computed(() => {
  if (mode.value === 'continue' && !prev.value && !props.segment.start?.startImage) return false;
  return true;
});
const runTitle = computed(() => {
  if (mode.value === 'continue' && !prev.value && !props.segment.start?.startImage) return 'Continue needs a previous approved take or a start image — or switch to Cut';
  if (!props.segment.intent?.trim() && !hasDraft.value) return 'Tip: describe what happens next, or write a prompt';
  return '';
});

function refDisabled(r) { return r.kind === 'voice' && mode.value !== 'cut'; }
function refTitle(r) {
  if (refDisabled(r)) return 'Voice references only apply in cut mode';
  return r.description || r.name;
}

async function save(patch) {
  try { await saveSegment(props.segment.id, patch); }
  catch (err) { filmState.status = `Error: ${err.message}`; }
}
function setMode(m) { save({ start: { ...(props.segment.start ?? {}), mode: m } }); }
function setIncludeTail(v) { save({ start: { ...(props.segment.start ?? {}), includePrevTail: v } }); }
function setStartImage(key) {
  const o = bankImages.value.find(x => x.key === key);
  save({ start: { ...(props.segment.start ?? {}), startImage: o ? { refId: o.refId, mediaId: o.mediaId } : null } });
}
function toggleRef(id, on) {
  const cur = new Set(props.segment.refIds ?? []);
  if (on) cur.add(id); else cur.delete(id);
  save({ refIds: [...cur] });
}

function onPromptInput(text) { setPromptDraft(props.segment.id, text); }
function clearDraft() { setPromptDraft(props.segment.id, ''); }

async function write() {
  try { await writePrompt(props.segment.id); } catch { /* status already set */ }
}
async function run() {
  try { await runSegment(props.segment.id); } catch { /* status already set */ }
}
async function del() {
  if (!confirm('Remove this segment?')) return;
  try { await deleteSegment(props.segment.id); } catch (err) { filmState.status = `Error: ${err.message}`; }
}
</script>

<style scoped>
.seg-editor { display: flex; flex-direction: column; }
.seg-editor-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.seg-editor-title { font-size: 14px; font-weight: 600; }
.seg-banner {
  font-size: 12px; padding: 8px 10px; margin-bottom: 10px; border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--warning, #d97706) 50%, var(--border));
  background: color-mix(in srgb, var(--warning, #d97706) 10%, transparent); color: var(--warning, #d97706);
}
.seg-field { margin-bottom: 12px; }
.seg-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.seg-modes { display: flex; gap: 16px; }
.seg-modes .checkbox-label { margin: 0; }
.seg-start { display: flex; align-items: flex-end; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.seg-start-img { height: 64px; border-radius: 4px; border: 1px solid var(--border); }
.zoomable { cursor: zoom-in; }
.zoomable:hover { border-color: var(--accent); }
.seg-refs { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.seg-ref { margin: 0; font-size: 12px; }
.seg-ref.disabled { opacity: .5; }
.seg-ref .chip { margin-right: 4px; font-size: 10px; }
.seg-prompt { width: 100%; font-family: inherit; }
.seg-run { display: flex; align-items: center; gap: 12px; margin: 4px 0 10px; }
.seg-progress { margin-bottom: 12px; }
</style>

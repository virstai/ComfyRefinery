<template>
  <div class="take-insp">
    <div class="take-insp-head">
      <span class="take-insp-title">Take {{ takeIndex + 1 }}</span>
      <span class="hint">{{ take.startMode }} · {{ (take.checkpoint ?? '').toUpperCase() }}<template v-if="take.durationSec"> · {{ take.durationSec.toFixed(2) }} s</template><template v-if="take.silent"> · silent</template><template v-if="take.seed != null"> · seed {{ take.seed }}</template></span>
      <button class="icon-btn small" style="margin-left:auto" :title="open ? 'Collapse' : 'Expand'" @click="open = !open">{{ open ? '▾' : '▸' }}</button>
    </div>
    <template v-if="open">
      <div class="detail-field"><label>Prompt</label><div class="val take-insp-prompt">{{ take.prompt }}</div></div>
      <div v-if="take.loras?.length" class="detail-field"><label>LoRAs</label><div class="val">{{ take.loras.map(l => `${l.name} ×${l.weight}`).join(', ') }}</div></div>
      <div v-if="take.note" class="detail-field"><label>Note</label><div class="val">{{ take.note }}</div></div>
      <div v-if="take.warnings?.length" class="detail-field"><label>Warnings</label><div class="val"><div v-for="w in take.warnings" :key="w">⚠ {{ w }}</div></div></div>

      <!-- Capture -->
      <div class="take-insp-capture">
        <div class="seg-label">Capture into the bank <span class="hint">from the preview at {{ t.toFixed(2) }}s</span></div>
        <select v-model="target" :disabled="busy">
          <option value="__new">New entry…</option>
          <option v-for="r in project.refs" :key="r.id" :value="r.id">{{ r.name }} ({{ r.kind }})</option>
        </select>
        <RefEntryForm v-if="target === '__new'" v-model="newRef" />
        <div class="hr-actions" style="flex-wrap:wrap">
          <button class="secondary small" :disabled="busy || !targetValid || !isPreviewed" :title="isPreviewed ? '' : 'Show this take in the preview first'" @click="captureFrame">Frame @ {{ t.toFixed(2) }}s</button>
          <button class="secondary small" :disabled="busy || !isPreviewed" @click="markIn = t">In{{ markIn != null ? ` ${markIn.toFixed(2)}s` : '' }}</button>
          <button class="secondary small" :disabled="busy || !isPreviewed" @click="markOut = t">Out{{ markOut != null ? ` ${markOut.toFixed(2)}s` : '' }}</button>
          <button class="secondary small" :disabled="busy || !targetValid || !(markOut > markIn)" :title="take.silent ? 'This take has no audio' : ''" @click="captureAudio">Audio{{ markIn != null && markOut != null ? ` ${markIn.toFixed(2)}–${markOut.toFixed(2)}s` : '' }}</button>
        </div>
        <p class="hint">Scrub the preview player, then capture the frame as an image reference, or an in/out range as a voice or sound reference.</p>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import RefEntryForm from './RefEntryForm.vue';
import { filmState, captureFromTake } from '../../stores/film.js';

const props = defineProps({
  take:    { type: Object, required: true },
  segment: { type: Object, required: true },
  project: { type: Object, required: true },
});

const open    = ref(true);
const busy    = ref(false);
const markIn  = ref(null);
const markOut = ref(null);
const target  = ref('__new');
const newRef  = ref({ kind: 'character', name: '', description: '' });

const takeIndex   = computed(() => props.segment.takes.findIndex(t => t.id === props.take.id));
const isPreviewed = computed(() => filmState.preview.takeId === props.take.id);
const t           = computed(() => isPreviewed.value ? filmState.previewTime : 0);
const targetValid = computed(() => target.value !== '__new' || !!newRef.value.name.trim());

watch(() => props.take.id, () => { markIn.value = null; markOut.value = null; });

function captureTarget() {
  return target.value === '__new'
    ? { newRef: { kind: newRef.value.kind, name: newRef.value.name.trim(), description: newRef.value.description.trim() } }
    : { refId: target.value };
}
async function captureFrame() {
  busy.value = true;
  try {
    const res = await captureFromTake(props.take.id, { frame: Number(t.value.toFixed(3)) }, captureTarget());
    filmState.status = `Captured frame into "${res.ref?.name ?? 'reference'}"`;
    if (target.value === '__new' && res.ref?.id) target.value = res.ref.id;
  } catch (err) { filmState.status = `Error: ${err.message}`; }
  finally { busy.value = false; }
}
async function captureAudio() {
  busy.value = true;
  try {
    const res = await captureFromTake(props.take.id, { audio: [Number(markIn.value.toFixed(3)), Number(markOut.value.toFixed(3))] }, captureTarget());
    filmState.status = `Captured audio into "${res.ref?.name ?? 'reference'}"`;
    if (target.value === '__new' && res.ref?.id) target.value = res.ref.id;
  } catch (err) { filmState.status = `Error: ${err.message}`; }
  finally { busy.value = false; }
}
</script>

<style scoped>
.take-insp { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; margin-bottom: 12px; background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
.take-insp-head { display: flex; align-items: center; gap: 8px; }
.take-insp-title { font-size: 13px; font-weight: 600; }
.take-insp-prompt { max-height: 140px; overflow-y: auto; }
.take-insp-capture { display: flex; flex-direction: column; gap: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
.take-insp-capture select { max-width: 100%; }
.seg-label { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px; }
.icon-btn.small { padding: 2px 6px; font-size: 12px; }
.hr-actions { display: flex; align-items: center; gap: 6px; }
</style>

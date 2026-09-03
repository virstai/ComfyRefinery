<template>
  <div class="imggen">
    <div class="imggen-head">
      <span class="imggen-title">Generate an image</span>
      <span class="hint">{{ segment ? `becomes segment ${segment.index + 1}'s start frame` : 'goes into the reference bank' }}</span>
      <button class="icon-btn small" style="margin-left:auto" title="Close" :disabled="busy" @click="$emit('close')">✕</button>
    </div>
    <div class="row">
      <label style="flex:2">Image model
        <select v-model="modelId" :disabled="busy">
          <option v-for="m in imageModels" :key="m.id" :value="m.id">{{ m.label }} ({{ m.architecture }})</option>
        </select>
      </label>
      <label>Width<input type="number" v-model="width" :placeholder="String(sizeHint.width)" :disabled="busy"></label>
      <label>Height<input type="number" v-model="height" :placeholder="String(sizeHint.height)" :disabled="busy"></label>
      <label>Seed<input type="number" v-model="seed" placeholder="random" :disabled="busy"></label>
    </div>
    <label>Describe it
      <textarea class="steering-input" rows="2" v-model="intent" :disabled="busy || writing" placeholder="In your own words — the LLM turns it into this model's prompt (using the model's skill, the film's logline and script, and the segment's references)."></textarea>
    </label>
    <label>Director's notes
      <input v-model="steering" :disabled="busy || writing" placeholder="framing, lighting, mood (optional)">
    </label>
    <div class="imggen-prompt-head">
      <span>Prompt</span>
      <button class="secondary small" :disabled="busy || writing || !intent.trim() || filmState.running" :title="intent.trim() ? '' : 'Describe the image first'" @click="write">✎ Write prompt</button>
      <span class="hint">{{ writing ? 'Writing…' : prompt ? 'This exact text is generated. Edit freely.' : 'Write one from the description, or type the model\'s prompt directly.' }}</span>
    </div>
    <textarea class="steering-input" rows="3" :readonly="writing" :value="writing ? streaming : prompt" :disabled="busy" placeholder="The image model's own prompt language — e.g. anima tags: 1girl, red scarf, rainy diner at night, cinematic…" @input="prompt = $event.target.value"></textarea>
    <label v-if="hasNegative">Negative prompt
      <input v-model="negativePrompt" :disabled="busy" :placeholder="archDefaults.negativePrompt || 'model default'">
    </label>

    <div class="imggen-target">
      <span class="hint">Save as</span>
      <select v-model="target" :disabled="busy">
        <option value="__new">New bank entry…</option>
        <option v-for="r in project.refs" :key="r.id" :value="r.id">{{ r.name }} ({{ r.kind }})</option>
      </select>
      <RefEntryForm v-if="target === '__new'" v-model="draft" />
    </div>
    <label v-if="segment" class="checkbox-label"><input type="checkbox" v-model="useAsStart" :disabled="busy"> Use as the start frame of segment {{ segment.index + 1 }} (switches it to Continue)</label>

    <div class="imggen-run">
      <button v-if="!busy" class="primary small" :disabled="!canRun || filmState.running" :title="canRun ? '' : 'Pick a model and write a prompt'" @click="go">✨ Generate</button>
      <button v-else class="danger small" @click="killRun">■ Stop</button>
      <span class="hint">{{ busy ? filmState.status : filmState.running ? 'Another job is running' : '' }}</span>
    </div>
    <div v-if="busy" class="seg-progress">
      <div class="progress-bar"><div class="fill" :style="{ width: filmState.progress + '%' }"></div></div>
      <img v-if="filmState.previewUrl" :src="filmState.previewUrl" class="imggen-preview" alt="">
    </div>
    <div v-if="result" class="imggen-result">
      <img :src="result.url" class="imggen-preview zoomable" alt="" title="Click to enlarge" @click="openLightbox(result.url, `${result.refName} · seed ${result.seed}`)">
      <span class="hint">Saved to "{{ result.refName }}" · seed {{ result.seed }}. Not right? Change the prompt or seed and generate again.</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import RefEntryForm from './RefEntryForm.vue';
import { configState } from '../../stores/config.js';
import { filmState, generateImage, writeImagePrompt, killRun } from '../../stores/film.js';
import { openLightbox } from '../../stores/lightbox.js';

const props = defineProps({
  project: { type: Object, required: true },
  segment: { type: Object, default: null },
});
const emit = defineEmits(['close', 'generated']);

const imageModels = computed(() => Object.values(configState.config?.models ?? {})
  .filter(m => !configState.archMeta?.[m.architecture]?.videoArch));

const modelId  = ref(imageModels.value[0]?.id ?? '');
const prompt   = ref('');
const intent   = ref('');
const steering = ref('');
const writing  = ref(false);
const streaming = ref('');
const negativePrompt = ref('');
const width    = ref('');
const height   = ref('');
const seed     = ref('');
const target   = ref('__new');
const draft    = ref({ kind: 'scene', name: '', description: '' });
const useAsStart = ref(!!props.segment);
const busy     = ref(false);
const result   = ref(null);

const model        = computed(() => configState.config?.models?.[modelId.value]);
const archMetaFor  = computed(() => configState.archMeta?.[model.value?.architecture] ?? {});
const archDefaults = computed(() => archMetaFor.value.defaults ?? {});
const hasNegative  = computed(() => !!archMetaFor.value.fields?.negativePrompt);

// The film's aspect ratio at the image arch's pixel budget (mirrors the server default).
const sizeHint = computed(() => {
  const d = archDefaults.value;
  const f = props.project.format ?? {};
  if (!d.width || !d.height || !f.width || !f.height) return { width: d.width ?? '', height: d.height ?? '' };
  const ar = f.width / f.height;
  let h = Math.sqrt((d.width * d.height) / ar);
  let w = h * ar;
  // no edge beyond the arch's default long edge (same rule as the server's fitToBudget)
  const maxDim = Math.max(d.width, d.height);
  const scale = Math.min(1, maxDim / Math.max(w, h));
  w *= scale; h *= scale;
  const r = v => Math.max(64, Math.round(v / 64) * 64);
  return { width: r(w), height: r(h) };
});

const canRun = computed(() => !!modelId.value && !!prompt.value.trim() && (target.value !== '__new' || true));

async function write() {
  writing.value = true; streaming.value = '';
  try {
    const text = await writeImagePrompt(
      { modelId: modelId.value, intent: intent.value.trim(), steering: steering.value.trim(), ...(props.segment ? { segmentId: props.segment.id } : {}) },
      token => { streaming.value += token; },
    );
    if (text) prompt.value = text;
  } catch (err) {
    filmState.status = `Error: ${err.message}`;
  } finally {
    writing.value = false;
  }
}

async function go() {
  busy.value = true; result.value = null;
  try {
    const body = {
      modelId: modelId.value, prompt: prompt.value.trim(), intent: intent.value.trim(),
      ...(negativePrompt.value ? { negativePrompt: negativePrompt.value } : {}),
      ...(width.value  ? { width:  Number(width.value) }  : {}),
      ...(height.value ? { height: Number(height.value) } : {}),
      ...(seed.value !== '' ? { seed: Number(seed.value) } : {}),
      ...(target.value === '__new'
        ? { newRef: { kind: draft.value.kind, name: draft.value.name.trim(), description: draft.value.description.trim() } }
        : { refId: target.value }),
      ...(props.segment && useAsStart.value ? { segmentId: props.segment.id } : {}),
    };
    const res = await generateImage(body);
    if (res) {
      result.value = { url: res.url, refName: res.ref?.name ?? '', seed: res.seed };
      if (target.value === '__new' && res.ref) target.value = res.ref.id;   // further attempts join the same entry
      emit('generated', res);
    }
  } catch (err) {
    filmState.status = `Error: ${err.message}`;
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.imggen { border: 1px solid var(--accent); border-radius: var(--radius); padding: 10px 12px; margin: 8px 0 12px; background: var(--surface); }
.imggen-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.imggen-title { font-size: 13px; font-weight: 600; }
.imggen-target { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0 8px; }
.imggen-target select { max-width: 260px; }
.imggen-run { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.imggen-preview { margin-top: 8px; max-height: 200px; border-radius: 4px; border: 1px solid var(--border); display: block; }
.imggen-result { margin-top: 6px; }
.imggen-prompt-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); margin: 6px 0 4px; }
.zoomable { cursor: zoom-in; }
.zoomable:hover { border-color: var(--accent); }
.icon-btn.small { padding: 2px 6px; font-size: 12px; }
.seg-progress { margin: 6px 0; }
</style>

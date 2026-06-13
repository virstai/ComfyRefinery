<template>
  <div id="model-editor">
    <hr>
    <h3>{{ modelId ? `Edit: ${model?.label || modelId}` : 'New model' }}</h3>

    <label>Name / label
      <input type="text" v-model="form.label" placeholder="My Flux Dev">
    </label>

    <label>Architecture
      <div style="display:flex; align-items:center; gap:6px;">
        <select v-model="form.architecture" style="flex:1;">
          <option value="">— select —</option>
          <option v-for="(meta, key) in archMeta" :key="key" :value="key">{{ meta.label || key }}</option>
        </select>
        <button
          v-if="form.architecture"
          type="button"
          class="icon-btn"
          style="flex-shrink:0;"
          title="Setup guide for this architecture"
          @click="showHelp = true"
        >?</button>
      </div>
    </label>
    <p v-if="archNotes" class="hint">{{ archNotes }}</p>

    <!-- Checkpoint (non-split) -->
    <div v-if="showCheckpoint">
      <label>Checkpoint
        <select v-model="form.checkpoint">
          <option value="">— select —</option>
          <optgroup v-if="assets.comfyui?.checkpoints?.length" label="Checkpoints">
            <option v-for="c in assets.comfyui.checkpoints" :key="c" :value="c">{{ c }}</option>
          </optgroup>
          <optgroup v-if="assets.comfyui?.unets?.length" label="UNet (diffusion_models)">
            <option v-for="u in assets.comfyui.unets" :key="u" :value="u">{{ u }}</option>
          </optgroup>
        </select>
      </label>
      <span v-if="canToggleSplit" class="hint">Optional — leave blank if using split loading below</span>
    </div>

    <!-- Split-load toggle (split-or-checkpoint archs only) -->
    <div v-if="canToggleSplit">
      <label class="checkbox-label">
        <input type="checkbox" v-model="form.splitLoad"> Use split loading (separate UNet + CLIP + VAE files)
      </label>
    </div>

    <!-- UNet (primary — or high-noise expert for Wan 2.2 MoE) -->
    <label v-if="showSplitField && hasField('unetName')">{{ hasField('unetName2') ? 'High-noise UNet file' : 'UNet file' }}
      <select v-model="form.unetName">
        <option value="">— select —</option>
        <option v-for="u in assets.comfyui?.unets" :key="u" :value="u">{{ u }}</option>
      </select>
    </label>
    <p v-if="showSplitField && fieldHint('unetName')" class="hint">{{ fieldHint('unetName') }}</p>

    <!-- UNet 2 (low-noise expert for Wan 2.2 MoE) -->
    <label v-if="showSplitField && hasField('unetName2')">Low-noise UNet file
      <select v-model="form.unetName2">
        <option value="">— none —</option>
        <option v-for="u in assets.comfyui?.unets" :key="u" :value="u">{{ u }}</option>
      </select>
    </label>
    <p v-if="showSplitField && fieldHint('unetName2')" class="hint">{{ fieldHint('unetName2') }}</p>

    <!-- Enum fields (e.g. model quantization) rendered after UNet fields -->
    <label v-if="showSplitField && fieldOptions('modelQuantization')">{{ fieldLabel('modelQuantization') }}
      <select v-model="form.modelQuantization">
        <option value="">— select —</option>
        <option v-for="opt in fieldOptions('modelQuantization')" :key="opt" :value="opt">{{ opt }}</option>
      </select>
    </label>

    <!-- CLIP-L (Flux / Anima) -->
    <label v-if="showSplitField && hasField('clipL')">CLIP-L file
      <select v-model="form.clipL">
        <option value="">— select —</option>
        <option v-for="c in assets.comfyui?.clips" :key="c" :value="c">{{ c }}</option>
      </select>
    </label>

    <!-- T5-XXL (Flux only) -->
    <label v-if="showSplitField && hasField('t5xxl')">T5-XXL file
      <select v-model="form.t5xxl">
        <option value="">— select —</option>
        <option v-for="c in assets.comfyui?.clips" :key="c" :value="c">{{ c }}</option>
      </select>
    </label>

    <!-- Single text encoder: T5 for Chroma, Mistral 3 / Qwen 3 for Flux 2 -->
    <label v-if="showSplitField && hasField('clipName')">Text encoder file
      <select v-model="form.clipName">
        <option value="">— select —</option>
        <option v-for="c in assets.comfyui?.clips" :key="c" :value="c">{{ c }}</option>
      </select>
    </label>

    <!-- VAE (split archs) -->
    <label v-if="showSplitField && hasField('vaeName')">VAE file
      <select v-model="form.vaeName">
        <option value="">— select —</option>
        <option v-for="v in assets.comfyui?.vaes" :key="v" :value="v">{{ v }}</option>
      </select>
    </label>

    <!-- VAE precision enum (e.g. WanVideo) -->
    <label v-if="showSplitField && fieldOptions('vaePrecision')">{{ fieldLabel('vaePrecision') }}
      <select v-model="form.vaePrecision">
        <option value="">— select —</option>
        <option v-for="opt in fieldOptions('vaePrecision')" :key="opt" :value="opt">{{ opt }}</option>
      </select>
    </label>

    <!-- External VAE override (checkpoint archs) -->
    <label v-if="showCheckpoint && hasField('vae')">External VAE <span class="hint">(optional — overrides baked-in)</span>
      <select v-model="form.vae">
        <option value="">— use checkpoint VAE —</option>
        <option v-for="v in assets.comfyui?.vaes" :key="v" :value="v">{{ v }}</option>
      </select>
    </label>

    <!-- SDXL refiner -->
    <div v-if="hasField('refiner')">
      <label class="checkbox-label">
        <input type="checkbox" v-model="form.useRefiner"> Use SDXL refiner
      </label>
      <div v-if="form.useRefiner" class="indent">
        <label>Refiner checkpoint
          <select v-model="form.refinerCheckpoint">
            <option value="">— select —</option>
            <optgroup v-if="assets.comfyui?.checkpoints?.length" label="Checkpoints">
              <option v-for="c in assets.comfyui.checkpoints" :key="c" :value="c">{{ c }}</option>
            </optgroup>
          </select>
        </label>
      </div>
    </div>

    <!-- Reference adapter (IPAdapter for sd15/sdxl/anima, Redux for flux/flux2) -->
    <div v-if="adapterModelType">
      <hr>
      <strong>Reference adapter</strong>
      <span class="hint"> — used when a workflow step is set to "adapter" mode for multiple references</span>
      <label style="margin-top:8px">Adapter model
        <select v-model="form.adapterModel">
          <option value="">— none —</option>
          <option v-for="m in adapterModelList" :key="m" :value="m">{{ m }}</option>
        </select>
        <span v-if="!adapterModelList.length" class="hint">
          {{ adapterModelType === 'ipa' ? 'No IPAdapter models found (requires IPAdapter custom nodes).' : 'No Redux/style models found in ComfyUI.' }}
        </span>
      </label>
      <label v-if="hasField('clipVisionModel')">CLIP Vision model
        <select v-model="form.clipVisionModel">
          <option value="">— none —</option>
          <option v-for="m in assets.comfyui?.clipVisionModels ?? []" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label v-if="hasField('adapterWeight')">Adapter weight <span class="hint">(0–1, distributed across all refs)</span>
        <input type="number" v-model.number="form.adapterWeight" min="0" max="1" step="0.05" placeholder="0.6">
      </label>
    </div>

    <!-- ControlNet (pose) -->
    <div v-if="hasField('controlNetModel')">
      <hr>
      <strong>ControlNet</strong>
      <span class="hint"> — used when a workflow step enables the pose ControlNet</span>
      <label style="margin-top:8px">ControlNet model
        <select v-model="form.controlNetModel">
          <option value="">— none —</option>
          <option v-for="m in assets.comfyui?.controlNets ?? []" :key="m" :value="m">{{ m }}</option>
        </select>
        <span v-if="!(assets.comfyui?.controlNets ?? []).length" class="hint">
          No ControlNet models found in ComfyUI's models/controlnet folder.
        </span>
      </label>
    </div>

    <div class="panel-actions">
      <button class="primary"               @click="save">Save model</button>
      <button class="secondary"             @click="$emit('cancel')">Cancel</button>
      <button v-if="modelId" class="danger" @click="remove">Delete</button>
    </div>

    <ArchHelpModal
      v-if="showHelp"
      :arch="form.architecture"
      :arch-label="archLabel"
      @close="showHelp = false"
    />
  </div>
</template>

<script setup>
import { reactive, computed, watch, ref } from 'vue';
import { saveModel, deleteModel } from '../stores/config.js';
import ArchHelpModal from './ArchHelpModal.vue';

const props = defineProps({
  modelId:  { type: String, default: null },
  model:    { type: Object, default: null },
  archMeta: { type: Object, default: () => ({}) },
  assets:   { type: Object, default: () => ({}) },
});
const emit = defineEmits(['saved', 'deleted', 'cancel']);

const form = reactive({
  label: '', architecture: '', splitLoad: false,
  checkpoint: '', unetName: '', unetName2: '', clipL: '', t5xxl: '', clipName: '', vaeName: '',
  vae: '', useRefiner: false, refinerCheckpoint: '',
  adapterModel: '', clipVisionModel: '', adapterWeight: '', controlNetModel: '',
  modelQuantization: '', vaePrecision: '',
});

watch(() => props.model, m => {
  if (!m) { Object.keys(form).forEach(k => { form[k] = k === 'splitLoad' || k === 'useRefiner' ? false : ''; }); return; }
  form.label             = m.label             ?? '';
  form.architecture      = m.architecture      ?? '';
  form.splitLoad         = !!(m.unetName || props.archMeta[m.architecture]?.loadingMode === 'split');
  form.checkpoint        = m.checkpoint        ?? '';
  form.unetName          = m.unetName          ?? '';
  form.unetName2         = m.unetName2         ?? '';
  form.modelQuantization = m.modelQuantization ?? '';
  form.vaePrecision      = m.vaePrecision      ?? '';
  form.clipL             = m.clipL             ?? '';
  form.t5xxl             = m.t5xxl             ?? '';
  form.clipName          = m.clipName          ?? '';
  form.vaeName           = m.vaeName           ?? '';
  form.vae               = m.vae               ?? '';
  form.useRefiner        = !!m.refinerCheckpoint;
  form.refinerCheckpoint = m.refinerCheckpoint ?? '';
  form.adapterModel      = m.adapterModel      ?? '';
  form.controlNetModel   = m.controlNetModel   ?? '';
  form.clipVisionModel   = m.clipVisionModel   ?? '';
  form.adapterWeight     = m.adapterWeight     ?? '';
}, { immediate: true });

const arch           = computed(() => form.architecture);
const archLabel  = computed(() => props.archMeta[arch.value]?.label || arch.value);
const showHelp   = ref(false);
const loadingMode    = computed(() => props.archMeta[arch.value]?.loadingMode ?? '');
const isForcedSplit  = computed(() => loadingMode.value === 'split');
const canToggleSplit = computed(() => loadingMode.value === 'split-or-checkpoint');
const isSplit        = computed(() => isForcedSplit.value || (canToggleSplit.value && form.splitLoad));
const showCheckpoint = computed(() => !isSplit.value && loadingMode.value !== '');
const showSplitField = computed(() => isSplit.value);
const archNotes      = computed(() => props.archMeta[arch.value]?.notes ?? null);

// 'ipa' for sd15/sdxl, 'redux' for flux/flux2, falsy for others
const adapterModelType = computed(() => props.archMeta[arch.value]?.fields?.adapterModel || null);
const adapterModelList = computed(() => {
  if (adapterModelType.value === 'ipa')   return props.assets?.comfyui?.ipAdapterModels ?? [];
  if (adapterModelType.value === 'redux') return props.assets?.comfyui?.reduxModels ?? [];
  return [];
});

function hasField(name) {
  return !!(props.archMeta[arch.value]?.fields?.[name]);
}

function fieldHint(name) {
  const hint = props.archMeta[arch.value]?.fieldHints?.[name];
  return typeof hint === 'string' ? hint : null;
}

function fieldOptions(name) {
  const val = props.archMeta[arch.value]?.fields?.[name];
  return Array.isArray(val) ? val : null;
}

function fieldLabel(name) {
  return props.archMeta[arch.value]?.fieldLabels?.[name] || name;
}

async function save() {
  if (!form.label.trim()) return alert('Enter a name for this model.');
  if (!form.architecture)  return alert('Select an architecture.');

  const data = {
    label:             form.label.trim(),
    architecture:      form.architecture,
    checkpoint:        (!isSplit.value && form.checkpoint)  ? form.checkpoint  : null,
    unetName:          (isSplit.value  && form.unetName)    ? form.unetName    : null,
    unetName2:         (isSplit.value  && form.unetName2)        ? form.unetName2        : null,
    modelQuantization: (isSplit.value  && form.modelQuantization) ? form.modelQuantization : null,
    vaePrecision:      (isSplit.value  && form.vaePrecision)      ? form.vaePrecision      : null,
    vaeName:           (isSplit.value  && form.vaeName)     ? form.vaeName     : null,
    clipL:             (isSplit.value  && form.clipL)       ? form.clipL       : null,
    t5xxl:             (isSplit.value  && form.t5xxl)       ? form.t5xxl       : null,
    clipName:          (isSplit.value  && form.clipName)    ? form.clipName    : null,
    vae:               form.vae              || null,
    refinerCheckpoint: (form.useRefiner && form.refinerCheckpoint) ? form.refinerCheckpoint : null,
    adapterModel:      form.adapterModel    || null,
    controlNetModel:   form.controlNetModel || null,
    clipVisionModel:   form.clipVisionModel || null,
    adapterWeight:     form.adapterWeight !== '' ? Number(form.adapterWeight) : null,
  };

  await saveModel(props.modelId, data);
  emit('saved');
}

async function remove() {
  if (!confirm(`Delete "${props.model?.label}"?`)) return;
  await deleteModel(props.modelId);
  emit('deleted');
}
</script>

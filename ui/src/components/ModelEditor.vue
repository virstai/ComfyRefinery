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

    <!-- Tile ControlNet (sd15/sdxl) -->
    <div v-if="hasField('tileControlNetModel')">
      <hr>
      <strong>Tile ControlNet</strong>
      <span class="hint"> — used when a workflow step uses tile mode for chain input or reference guidance</span>
      <label style="margin-top:8px">Tile ControlNet model
        <select v-model="form.tileControlNetModel">
          <option value="">— none —</option>
          <option v-for="m in assets.comfyui?.controlNets ?? []" :key="m" :value="m">{{ m }}</option>
        </select>
        <span v-if="!(assets.comfyui?.controlNets ?? []).length" class="hint">
          No ControlNet models found in ComfyUI's models/controlnet folder.
        </span>
      </label>
    </div>

    <!-- Structural ControlNet (sd15/sdxl) -->
    <div v-if="hasField('structuralControlNetModel')">
      <hr>
      <strong>Structural ControlNet</strong>
      <span class="hint"> — extracts depth/edges from a previous step's output as layout guidance; the model generates pure txt2img for full style freedom</span>
      <label style="margin-top:8px">Structural ControlNet model
        <select v-model="form.structuralControlNetModel">
          <option value="">— none —</option>
          <option v-for="m in assets.comfyui?.controlNets ?? []" :key="m" :value="m">{{ m }}</option>
        </select>
      </label>
      <label v-if="form.structuralControlNetModel" style="margin-top:8px">Preprocessor
        <select v-model="form.structuralControlNetPreprocessor">
          <option value="depth">Depth (MiDaS) — matches depth CN models</option>
          <option value="softedge">Soft edges (HED) — matches softedge CN models</option>
          <option value="lineart_realistic">Lineart realistic — matches lineart CN models</option>
          <option value="lineart_anime">Lineart anime — matches lineart CN models</option>
          <option value="canny">Canny edges — matches canny CN models</option>
        </select>
      </label>
      <p class="hint">
        Pick a depth or softedge CN trained for this checkpoint. For Illustrious XL:
        <strong>illustriousXLv0.1_depth_midas_fp16</strong> (stronger spatial layout) or
        <strong>illustriousXLv0.1_Softedge_fp16</strong> (looser, more style freedom).
        The preprocessor must match the CN model — depth CN → MiDaS, softedge CN → HED.
        Use a CN trained for the same base model — mismatched ones (e.g. windsingai tile) cause washed-out output.
        See <em>docs/arch/sdxl.md</em> for download links.
      </p>
    </div>

    <!-- Skill section -->
    <div v-if="modelId && skillData" class="skill-section">
      <hr>

      <!-- Simplified view when skill refinement is globally disabled -->
      <template v-if="config.skillRefinement === false">
        <h3>Model Skill <span class="hint" style="font-weight:normal">(refinement disabled — architecture default)</span></h3>
        <div v-if="defaultSkill" class="skill-text">{{ defaultSkill }}</div>
        <div v-else class="hint">No default skill for this architecture.</div>
      </template>

      <!-- Full skill panel when refinement is enabled -->
      <template v-else>
        <div class="skill-header">
          <h3>Model Skill</h3>
          <label class="skill-lock">
            <input type="checkbox" :checked="skillLocked" @change="toggleLock">
            <span :class="{ 'skill-lock-active': skillLocked }">{{ skillLocked ? 'Locked' : 'Lock updates' }}</span>
          </label>
        </div>

        <div v-if="skillLocked" class="skill-lock-banner">
          Auto-updates paused — unlock to allow skill refreshes.
        </div>

        <div v-if="activeVersion?.skill && !usingDefault" class="skill-text">{{ activeVersion.skill }}</div>
        <div v-else-if="defaultSkill" class="skill-text">{{ defaultSkill }}</div>

        <div v-if="usingDefault && defaultSkill" class="hint">Architecture default — will be refined after the first session</div>
        <div v-else-if="activeVersion" class="hint">{{ formatDate(activeVersion.createdAt) }} · {{ activeVersion.source }}</div>

        <div v-if="!skillLocked" class="skill-correction">
          <textarea
            v-model="correctionNote"
            rows="3"
            placeholder="Describe what the agent got wrong or should change (optional)…"
            :disabled="refreshing"
          ></textarea>
          <button class="small primary" :disabled="refreshing" @click="doRefreshSkill">
            {{ refreshing ? 'Refreshing…' : 'Refresh skill' }}
          </button>
        </div>

        <template v-if="activeVersion && activeSessions > 0">
          <h3 style="margin-top:14px">Outcomes</h3>
          <div class="ln-header">
            <span class="ln-rate">{{ activeVersion.outcomes.accepts }}/{{ activeSessions }} accepted</span>
            <div class="ln-bar"><div class="ln-fill" :style="{ width: outcomeRate + '%' }"></div></div>
            <span class="ln-pct">{{ outcomeRate }}%</span>
          </div>
        </template>

        <template v-if="sortedVersions.length > 0 || defaultSkill">
          <h3 style="margin-top:14px">Version History</h3>
          <div v-if="defaultSkill" class="ver-row ver-default" :class="{ 'ver-active': usingDefault }">
            <div class="ver-meta">
              <span class="ver-date">Built-in default</span>
              <span class="ver-source">architecture baseline</span>
            </div>
            <div class="ver-preview">{{ defaultSkill.slice(0, 90) + (defaultSkill.length > 90 ? '…' : '') }}</div>
            <div class="ver-actions">
              <button class="small secondary" :disabled="usingDefault" @click="doResetToDefault">Use</button>
            </div>
          </div>
          <div v-for="ver in sortedVersions" :key="ver.id" class="ver-row" :class="{ 'ver-active': ver.id === activeVersionId }">
            <div class="ver-meta">
              <span class="ver-date">{{ formatDate(ver.createdAt) }}</span>
              <span class="ver-source">{{ ver.source }}</span>
              <span class="ver-rate" :style="{ color: versionRateColor(ver) }">{{ versionRateText(ver) }}</span>
            </div>
            <div class="ver-preview">{{ ver.skill ? ver.skill.slice(0, 90) + (ver.skill.length > 90 ? '…' : '') : 'No skill text' }}</div>
            <div class="ver-actions">
              <button class="small secondary" :disabled="ver.id === activeVersionId" @click="doActivateVersion(ver.id)">Use</button>
              <button class="small danger"    :disabled="ver.id === activeVersionId" @click="doDeleteVersion(ver.id)">×</button>
            </div>
          </div>
        </template>
      </template>
    </div>

    <!-- Notes section -->
    <div v-if="modelId" class="skill-section">
      <hr>
      <h3>Notes</h3>
      <p v-if="!localNotes.length" class="hint">No notes yet — discoveries will appear here after sessions.</p>
      <div v-for="note in localNotes" :key="note.id" class="note-row">
        <label class="note-toggle">
          <input type="checkbox" :checked="note.enabled" @change="toggleNote(note.id)">
          <span v-if="note.type === 'enforce'" class="note-text">{{ note.text }}</span>
          <span v-else class="note-text"><strong>Blacklist:</strong> {{ (note.words ?? []).join(', ') }}</span>
        </label>
        <span v-if="note.auto" class="note-auto">auto</span>
        <button class="small danger" @click="deleteNote(note.id)">×</button>
      </div>
      <div class="note-add">
        <select v-model="addNoteType" class="note-add-select">
          <option value="enforce">Style enforcement</option>
          <option value="blacklist">Blacklist words</option>
        </select>
        <input
          v-model="addNoteText"
          class="note-add-input"
          :placeholder="addNoteType === 'enforce' ? 'e.g. Adapt photorealistic requests to anime style' : 'comma-separated words'"
          @keydown.enter="addNote"
        >
        <button class="small primary" @click="addNote">Add</button>
      </div>
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
import { saveModel, deleteModel, loadSkill, saveNotes, refreshSkill as apiRefreshSkill, activateSkillVersion, deleteSkillVersion, setSkillLocked, resetSkillToDefault } from '../stores/config.js';
import ArchHelpModal from './ArchHelpModal.vue';

const props = defineProps({
  modelId:  { type: String, default: null },
  model:    { type: Object, default: null },
  archMeta: { type: Object, default: () => ({}) },
  assets:   { type: Object, default: () => ({}) },
  config:   { type: Object, default: () => ({}) },
});
const emit = defineEmits(['saved', 'deleted', 'cancel']);

// ── Skill / notes state ────────────────────────────────────────────────────────

const skillData      = ref(null);
const localNotes     = ref([]);
const addNoteType    = ref('enforce');
const addNoteText    = ref('');
const correctionNote = ref('');
const refreshing     = ref(false);

watch(() => props.modelId, async id => {
  skillData.value  = null;
  localNotes.value = [];
  if (id) {
    skillData.value  = await loadSkill(id).catch(() => null);
    localNotes.value = (skillData.value?.notes ?? []).map(n => ({ ...n }));
  }
}, { immediate: true });

const activeVersionId = computed(() => skillData.value?.activeVersionId ?? null);
const activeVersion   = computed(() => (skillData.value?.versions ?? []).find(v => v.id === activeVersionId.value) ?? null);
const usingDefault    = computed(() => !activeVersionId.value);
const defaultSkill    = computed(() => skillData.value?.defaultSkill ?? null);
const activeSessions  = computed(() => { const o = activeVersion.value?.outcomes; return o ? o.accepts + o.rejects : 0; });
const skillLocked     = computed(() => skillData.value?.skillLocked ?? false);
const sortedVersions  = computed(() => [...(skillData.value?.versions ?? [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
const outcomeRate     = computed(() => {
  if (!activeSessions.value) return 0;
  return Math.round((activeVersion.value.outcomes.accepts / activeSessions.value) * 100);
});

function versionRateText(ver) {
  const total = ver.outcomes.accepts + ver.outcomes.rejects;
  if (!total) return 'no data';
  return `${ver.outcomes.accepts}/${total} (${Math.round(ver.outcomes.accepts / total * 100)}%)`;
}

function versionRateColor(ver) {
  const total = ver.outcomes.accepts + ver.outcomes.rejects;
  if (!total) return 'var(--muted)';
  const rate = ver.outcomes.accepts / total;
  if (rate >= 0.60) return 'var(--accent)';
  if (rate >= 0.30) return '#e6a817';
  return 'var(--danger, #e05)';
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function toggleLock() {
  const data = await setSkillLocked(props.modelId, !skillLocked.value);
  skillData.value = data;
}

async function doActivateVersion(versionId) {
  const data = await activateSkillVersion(props.modelId, versionId);
  skillData.value = data;
  localNotes.value = (data.notes ?? []).map(n => ({ ...n }));
}

async function doDeleteVersion(versionId) {
  if (!confirm('Delete this skill version?')) return;
  const data = await deleteSkillVersion(props.modelId, versionId);
  skillData.value = data;
  localNotes.value = (data.notes ?? []).map(n => ({ ...n }));
}

async function doResetToDefault() {
  const data = await resetSkillToDefault(props.modelId);
  skillData.value = data;
  localNotes.value = (data.notes ?? []).map(n => ({ ...n }));
}

async function doRefreshSkill() {
  if (refreshing.value || skillLocked.value) return;
  refreshing.value = true;
  try {
    const data = await apiRefreshSkill(props.modelId, correctionNote.value.trim());
    skillData.value  = data;
    localNotes.value = (data.notes ?? []).map(n => ({ ...n }));
    correctionNote.value = '';
  } catch (err) {
    alert(`Skill refresh failed: ${err.message}`);
  } finally {
    refreshing.value = false;
  }
}

async function persistNotes() {
  const data = await saveNotes(props.modelId, localNotes.value);
  skillData.value = data;
}

async function toggleNote(id) {
  const note = localNotes.value.find(n => n.id === id);
  if (note) { note.enabled = !note.enabled; await persistNotes(); }
}

async function deleteNote(id) {
  localNotes.value = localNotes.value.filter(n => n.id !== id);
  await persistNotes();
}

async function addNote() {
  const text = addNoteText.value.trim();
  if (!text) return;
  if (addNoteType.value === 'enforce') {
    localNotes.value.push({ id: genId(), type: 'enforce', enabled: false, auto: false, text });
  } else {
    for (const word of text.split(',').map(w => w.trim()).filter(Boolean)) {
      localNotes.value.push({ id: genId(), type: 'blacklist', words: [word], enabled: false, auto: false });
    }
  }
  addNoteText.value = '';
  await persistNotes();
}

// ── Model form state ───────────────────────────────────────────────────────────

const form = reactive({
  label: '', architecture: '', splitLoad: false,
  checkpoint: '', unetName: '', unetName2: '', clipL: '', t5xxl: '', clipName: '', vaeName: '',
  vae: '', useRefiner: false, refinerCheckpoint: '',
  adapterModel: '', clipVisionModel: '', adapterWeight: '', controlNetModel: '', tileControlNetModel: '', structuralControlNetModel: '', structuralControlNetPreprocessor: 'depth',
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
  form.adapterModel              = m.adapterModel              ?? '';
  form.controlNetModel           = m.controlNetModel           ?? '';
  form.tileControlNetModel       = m.tileControlNetModel       ?? '';
  form.structuralControlNetModel       = m.structuralControlNetModel       ?? '';
  form.structuralControlNetPreprocessor = m.structuralControlNetPreprocessor ?? 'depth';
  form.clipVisionModel           = m.clipVisionModel           ?? '';
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
    adapterModel:              form.adapterModel              || null,
    controlNetModel:           form.controlNetModel           || null,
    tileControlNetModel:       form.tileControlNetModel       || null,
    structuralControlNetModel:       form.structuralControlNetModel       || null,
    structuralControlNetPreprocessor: form.structuralControlNetModel ? (form.structuralControlNetPreprocessor || 'depth') : null,
    clipVisionModel:           form.clipVisionModel           || null,
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

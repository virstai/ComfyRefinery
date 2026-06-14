<template>
  <div id="workflow-editor">
    <hr>
    <h3>{{ workflowId ? `Edit: ${workflow?.label || workflowId}` : 'New workflow' }}</h3>

    <label>Name / label
      <input type="text" v-model="form.label" placeholder="Portrait 4x">
    </label>

    <!-- Steps -->
    <div v-for="(step, si) in form.steps" :key="si" class="step-block">
      <div class="step-header">
        <strong>Step {{ si + 1 }}: {{ step.type === 'upscale' ? 'Upscale' : step.type === 'video' ? 'Video' : 'Generate' }}</strong>
        <button v-if="form.steps.length > 1" class="small danger" @click="removeStep(si)">Remove</button>
      </div>

      <!-- ── Generate step ──────────────────────────────────────────────── -->
      <template v-if="step.type !== 'upscale' && step.type !== 'video'">
        <label>Model
          <select v-model="step.modelId">
            <option value="">— select model —</option>
            <template v-for="(m, id) in config.models" :key="id">
              <option v-if="!archMeta[m.architecture]?.videoArch" :value="id">
                {{ m.label || id }} ({{ m.architecture || '?' }})
              </option>
            </template>
          </select>
        </label>

        <div class="row">
          <label>Width  <input type="number" v-model.number="step.width"  step="64" :placeholder="archDefault(si, 'width')"></label>
          <label>Height <input type="number" v-model.number="step.height" step="64" :placeholder="archDefault(si, 'height')"></label>
          <label>Steps  <input type="number" v-model.number="step.steps"  min="1"   :placeholder="archDefault(si, 'steps')"></label>
        </div>
        <div class="row">
          <label v-if="showCfg(si)">CFG scale
            <input type="number" v-model.number="step.cfgScale" step="0.5" :placeholder="archDefault(si, 'cfgScale')">
          </label>
          <label v-if="showGuidance(si)">Guidance
            <input type="number" v-model.number="step.guidance" step="0.5" :placeholder="archDefault(si, 'guidance')">
          </label>
          <label>Sampler
            <select v-model="step.sampler">
              <option value="">arch default</option>
              <option>euler</option><option>euler_ancestral</option>
              <option>er_sde</option><option>dpmpp_2m</option>
              <option>dpmpp_2m_sde</option><option>dpmpp_3m_sde</option>
              <option>ddim</option><option>uni_pc</option>
            </select>
          </label>
          <label>Scheduler
            <select v-model="step.scheduler">
              <option value="">arch default</option>
              <option>normal</option><option>karras</option><option>exponential</option>
              <option>sgm_uniform</option><option>simple</option><option>beta</option>
            </select>
          </label>
        </div>

        <label v-if="showNegative(si)">Negative prompt <span class="hint">(leave blank for arch default)</span>
          <textarea v-model="step.negativePrompt" rows="2"></textarea>
        </label>

        <label v-if="stepArch(si) === 'sdxl'">Refiner switch at <span class="hint">(0–1, if model has refiner)</span>
          <input type="number" v-model.number="step.refinerSwitchAt" min="0" max="1" step="0.05" placeholder="0.8">
        </label>

        <!-- Image inputs: unified mode for previous step output + user references -->
        <div class="review-block">
          <strong>Image inputs</strong>
          <label v-if="config.llmExtras !== false" class="checkbox-label">
            <input type="checkbox" v-model="step.visionNotes"> Pass references to LLM for composition guidance
          </label>
          <div class="row" style="margin-top:4px">
            <label>Mode
              <select v-model="step.imageMode">
                <option value="txt2img">Ignore</option>
                <option value="init-image">Init-image (img2img)</option>
                <option v-if="archCap(si, 'adapter')" value="adapter">Adapter</option>
                <option v-if="archCap(si, 'tileControlNet')" value="tile">Tile ControlNet</option>
                <option v-if="archCap(si, 'structuralControlNet')" value="structural">Structural ControlNet</option>
              </select>
            </label>
<label v-if="step.imageMode === 'init-image'">Denoise
              <input type="number" v-model.number="step.imageDenoise" min="0.01" max="1" step="0.05" placeholder="0.6">
            </label>
            <label v-if="step.imageMode === 'tile' || step.imageMode === 'structural'">Strength
              <input type="number" v-model.number="step.imageStrength" min="0" max="2" step="0.05" :placeholder="step.imageMode === 'structural' ? '0.9' : '0.5'">
            </label>
            <label v-if="step.imageMode === 'tile'">Denoise
              <input type="number" v-model.number="step.imageDenoise" min="0.01" max="1" step="0.05" placeholder="0.65">
            </label>
          </div>
          <p v-if="step.imageMode === 'structural'" class="hint">
            Extracts structure (depth map, edges, etc.) from the previous step's output as ControlNet conditioning. The model generates from pure text — full style freedom. Preprocessor is configured on the model (Models panel) alongside the CN model file.
          </p>
          <p v-else-if="si > 0" class="hint">Applies to the previous step's output and user-uploaded references. If both are present, the previous step's output takes priority.</p>
        </div>

        <!-- LoRAs -->
        <div class="review-block" v-if="archCap(si, 'lora')">
          <strong>LoRAs</strong>
          <label v-if="config.llmExtras !== false" class="checkbox-label">
            <input type="checkbox" v-model="step.llmLoras"> LLM may add LoRAs (tool calling)
          </label>
          <div v-for="(l, li) in step.loras" :key="li" class="row" style="margin-top:6px">
            <label>Always-on LoRA
              <select v-model="l.name">
                <option value="">— select —</option>
                <option v-for="lr in lorasForStep(si)" :key="lr.filename" :value="lr.filename">{{ lr.label }} ({{ lr.filename }})</option>
              </select>
            </label>
            <label>Weight
              <input type="number" v-model.number="l.weight" min="0" max="2" step="0.05">
            </label>
            <button
              class="small danger"
              style="flex:0 0 auto; min-width:0; align-self:flex-end; margin-bottom:15px"
              @click="step.loras.splice(li, 1)"
            >Remove</button>
          </div>
          <button class="small secondary" style="margin-top:6px" @click="step.loras.push({ name: '', weight: 1.0 })">+ Add always-on LoRA</button>
          <p v-if="!lorasForStep(si).length" class="hint">No LoRAs registered for this model's architecture — see the LoRAs panel.</p>
        </div>

        <!-- Pose ControlNet -->
        <div class="review-block" v-if="archCap(si, 'controlNet')">
          <strong>Pose ControlNet</strong>
          <div class="row" style="margin-top:6px">
            <label>Pose mode
              <select v-model="step.poseMode">
                <option value="off">Off</option>
                <option value="auto">Auto (LLM decides)</option>
                <option value="always">Always</option>
              </select>
            </label>
            <template v-if="step.poseMode !== 'off'">
              <label>Strength
                <input type="number" v-model.number="step.cnStrength" min="0" max="2" step="0.05">
              </label>
            </template>
          </div>
          <p v-if="step.poseMode !== 'off'" class="hint">
            A pose draft is rendered with this step's model from a detection-friendly prompt
            (plain background, photo rendering; supports any framing and multiple subjects), the
            skeleton is extracted with DWPose, and the main generation follows it via ControlNet.
            The ControlNet weights are selected in the generation model's settings (Models panel).
            Strength below ~1.0 lets the prompt override the pose. If no pose can be extracted,
            the step fails rather than continuing.
          </p>
        </div>

      </template>

      <!-- ── Upscale step ───────────────────────────────────────────────── -->
      <template v-else-if="step.type === 'upscale'">
        <label>Upscale type
          <select v-model="step.upscaleType">
            <option value="model">Model upscaler (ESRGAN / RealESRGAN)</option>
            <option value="hires">Hires fix (re-diffusion)</option>
          </select>
        </label>

        <!-- Model upscaler -->
        <template v-if="step.upscaleType === 'model'">
          <div class="row">
            <label>Upscale model
              <select v-model="step.upscaleModel">
                <option value="">— select model —</option>
                <option v-for="m in upscaleModels" :key="m" :value="m">{{ m }}</option>
              </select>
              <span v-if="!upscaleModels.length" class="hint">No upscale models found in ComfyUI.</span>
            </label>
            <label>Output factor
              <select v-model.number="step.factor">
                <option :value="2">×2</option>
                <option :value="4">×4</option>
                <option :value="8">×8</option>
              </select>
            </label>
          </div>
        </template>

        <!-- Hires fix -->
        <template v-else>
          <label>Model <span class="hint">(checkpoint used for re-diffusion)</span>
            <select v-model="step.modelId">
              <option value="">— select model —</option>
              <template v-for="(m, id) in config.models" :key="id">
                <option v-if="!archMeta[m.architecture]?.videoArch" :value="id">
                  {{ m.label || id }} ({{ m.architecture || '?' }})
                </option>
              </template>
            </select>
          </label>
          <div class="row">
            <label>Scale
              <select v-model.number="step.scale">
                <option :value="2">×2</option>
                <option :value="4">×4</option>
              </select>
            </label>
            <label>Denoise
              <input type="number" v-model.number="step.denoise" min="0.01" max="1" step="0.05" placeholder="0.35">
            </label>
            <label>Steps
              <input type="number" v-model.number="step.steps" min="1" :placeholder="archDefault(si, 'steps')">
            </label>
          </div>
          <div class="row">
            <label v-if="showCfg(si)">CFG scale
              <input type="number" v-model.number="step.cfgScale" step="0.5" :placeholder="archDefault(si, 'cfgScale')">
            </label>
            <label>Sampler
              <select v-model="step.sampler">
                <option value="">arch default</option>
                <option>euler</option><option>euler_ancestral</option>
                <option>dpmpp_2m</option><option>dpmpp_2m_sde</option>
                <option>dpmpp_3m_sde</option><option>ddim</option><option>uni_pc</option>
              </select>
            </label>
            <label>Scheduler
              <select v-model="step.scheduler">
                <option value="">arch default</option>
                <option>normal</option><option>karras</option><option>exponential</option>
                <option>sgm_uniform</option><option>simple</option><option>beta</option>
              </select>
            </label>
          </div>
        </template>
      </template>

      <!-- ── Video step ────────────────────────────────────────────────── -->
      <template v-else-if="step.type === 'video'">
        <label>Video model
          <select v-model="step.modelId">
            <option value="">— select video model —</option>
            <option v-for="m in videoModels" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
          <span v-if="!videoModels.length" class="hint">No video models found. Add one in the Models panel.</span>
        </label>
        <div class="row">
          <label>Width  <input type="number" v-model.number="step.width"  step="16" placeholder="832"></label>
          <label>Height <input type="number" v-model.number="step.height" step="16" placeholder="480"></label>
          <label>Frames <input type="number" v-model.number="step.frames" step="1"  placeholder="49"></label>
          <label>FPS    <input type="number" v-model.number="step.fps"    step="1"  placeholder="16"></label>
        </div>
        <div class="row">
          <label>Steps    <input type="number" v-model.number="step.steps"    min="1"   placeholder="30"></label>
          <label>Guidance <input type="number" v-model.number="step.guidance" step="0.5" placeholder="6"></label>
        </div>
        <p class="hint">
          Video step is always terminal — generates once with no review or iteration.
          Input: previous step's accepted image → first reference → text-to-video.
        </p>
      </template>

      <!-- ── Review (generate and upscale steps only; hidden when review is globally disabled) ── -->
      <div v-if="step.type !== 'video' && config.reviewEnabled !== false" class="review-block">
        <strong>Review</strong>
        <div class="row">
          <label>Max iterations
            <input type="number" v-model.number="step.maxIterations" min="1" placeholder="3">
          </label>
          <label>Grace period (s)
            <input type="number" v-model.number="step.gracePeriod" min="0" placeholder="10">
          </label>
        </div>
        <label class="checkbox-label">
          <input type="checkbox" v-model="step.humanReview"> Require human review
        </label>
      </div>
    </div>

    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="secondary" @click="addGenerateStep">+ Add generate step</button>
      <button class="secondary" @click="addUpscaleStep">+ Add upscale step</button>
      <button class="secondary" :disabled="hasVideoStep" @click="addVideoStep">
        + Add video step{{ hasVideoStep ? ' (already added)' : '' }}
      </button>
    </div>

    <div class="panel-actions">
      <button class="primary"               @click="save">Save workflow</button>
      <button v-if="workflowId" class="danger" @click="remove">Delete</button>
    </div>
  </div>
</template>

<script setup>
import { reactive, computed, watch, ref, onMounted } from 'vue';
import { saveWorkflow, deleteWorkflow, loadLoras } from '../stores/config.js';

const props = defineProps({
  workflowId: { type: String, default: null },
  workflow:   { type: Object, default: null },
  config:     { type: Object, default: () => ({}) },
  archMeta:   { type: Object, default: () => ({}) },
  assets:     { type: Object, default: () => ({}) },
});
const emit = defineEmits(['saved', 'deleted']);

const upscaleModels = computed(() => {
  const list = props.assets?.comfyui?.upscaleModels;
  return Array.isArray(list) ? list : [];
});

const controlNetModels = computed(() => {
  const list = props.assets?.comfyui?.controlNets;
  return Array.isArray(list) ? list : [];
});

const loraRegistry = ref({});
onMounted(async () => { loraRegistry.value = await loadLoras().catch(() => ({})); });

function lorasForStep(si) {
  const arch = stepArch(si);
  return Object.values(loraRegistry.value).filter(l => l.architecture === arch);
}

function blankGenerateStep() {
  return {
    type: 'generate',
    modelId: '', width: '', height: '', steps: '', cfgScale: '', guidance: '',
    sampler: '', scheduler: '', negativePrompt: '', refinerSwitchAt: '',
    maxIterations: '', humanReview: false, gracePeriod: '',
    imageMode: 'txt2img', imageDenoise: '', imageStrength: '',
    visionNotes: false,
    loras: [], llmLoras: false,
    poseMode: 'off', cnStrength: 1.0,
  };
}

function blankUpscaleStep() {
  return {
    type: 'upscale', upscaleType: 'model',
    upscaleModel: '', factor: 4,
    modelId: '', scale: 2, denoise: 0.35, steps: '', cfgScale: '', sampler: '', scheduler: '',
    maxIterations: '', humanReview: false, gracePeriod: '',
  };
}

function blankVideoStep() {
  return {
    type: 'video',
    modelId: '', width: '', height: '', frames: '', fps: '', steps: '', guidance: '', cfgScale: '',
  };
}

function stepFromDef(s) {
  if (s.type === 'upscale') {
    return {
      type:         'upscale',
      upscaleType:  s.upscaleType  ?? 'model',
      upscaleModel: s.upscaleModel ?? '',
      factor:       s.factor       ?? 4,
      modelId:      s.modelId      ?? '',
      scale:        s.scale        ?? 2,
      denoise:      s.denoise      ?? 0.35,
      steps:        s.steps        ?? '',
      cfgScale:     s.cfgScale     ?? '',
      sampler:      s.sampler      ?? '',
      scheduler:    s.scheduler    ?? '',
      maxIterations: s.review?.maxIterations ?? '',
      humanReview:   s.review?.humanReview   ?? false,
      gracePeriod:   s.review?.gracePeriod   ?? '',
    };
  }
  if (s.type === 'video') {
    return {
      type:     'video',
      modelId:  s.modelId              ?? '',
      width:    s.params?.width        ?? '',
      height:   s.params?.height       ?? '',
      frames:   s.params?.frames       ?? '',
      fps:      s.params?.fps          ?? '',
      steps:    s.params?.steps        ?? '',
      guidance: s.params?.guidance     ?? '',
      cfgScale: s.params?.cfgScale     ?? '',
    };
  }
  // Unified image mode: chain strategy takes priority over reference strategy
  const chainMode    = s.chainStrategy?.mode;
  const hasTileRef   = s.controlNet?.tile?.enabled;
  const fallbackMode = hasTileRef ? 'tile'
    : (s.referenceStrategy?.diffusion?.mode
       ?? s.referenceStrategy?.diffusion?.many?.mode  // back-compat
       ?? s.referenceStrategy?.diffusion?.one?.mode   // back-compat
       ?? 'txt2img');
  return {
    type:           'generate',
    modelId:        s.modelId              ?? '',
    width:          s.params?.width        ?? '',
    height:         s.params?.height       ?? '',
    steps:          s.params?.steps        ?? '',
    cfgScale:       s.params?.cfgScale     ?? '',
    guidance:       s.params?.guidance     ?? '',
    sampler:        s.params?.sampler      ?? '',
    scheduler:      s.params?.scheduler    ?? '',
    negativePrompt: s.params?.negativePrompt ?? '',
    refinerSwitchAt: s.params?.refinerSwitchAt ?? '',
    imageMode:         chainMode ?? fallbackMode,
    imageDenoise:      s.chainStrategy?.denoise
                       ?? s.referenceStrategy?.diffusion?.denoise
                       ?? s.referenceStrategy?.diffusion?.one?.denoise  // back-compat
                       ?? s.referenceStrategy?.diffusion?.many?.denoise // back-compat
                       ?? '',
    imageStrength:     s.chainStrategy?.tileStrength ?? s.chainStrategy?.strength ?? s.controlNet?.tile?.strength ?? '',
    maxIterations:   s.review?.maxIterations ?? '',
    humanReview:     s.review?.humanReview   ?? false,
    gracePeriod:     s.review?.gracePeriod   ?? '',
    visionNotes:     s.referenceStrategy?.visionNotes ?? false,
    loras:           (s.loras ?? []).map(l => ({ ...l })),
    llmLoras:        s.llmLoras ?? false,
    poseMode:        s.controlNet?.poseMode  ?? 'off',
    cnStrength:      s.controlNet?.strength  ?? 1.0,
  };
}

const form = reactive({ label: '', steps: [blankGenerateStep()] });

watch(() => props.workflow, wf => {
  if (!wf) { form.label = ''; form.steps = [blankGenerateStep()]; return; }
  form.label = wf.label ?? '';
  form.steps = (wf.steps ?? []).map(stepFromDef);
  if (!form.steps.length) form.steps = [blankGenerateStep()];
}, { immediate: true });

function stepArch(si) {
  const modelId = form.steps[si]?.modelId;
  return modelId ? (props.config.models?.[modelId]?.architecture ?? '') : '';
}

function archDefault(si, key) {
  const arch = stepArch(si);
  const d = arch ? props.archMeta[arch]?.defaults : null;
  return d?.[key] != null ? String(d[key]) : 'default';
}

function archCap(si, name) {
  return !!props.archMeta[stepArch(si)]?.capabilities?.[name];
}

function capsForModel(modelId) {
  const arch = props.config.models?.[modelId]?.architecture;
  return props.archMeta[arch]?.capabilities ?? {};
}

function archField(si, name) {
  return !!props.archMeta[stepArch(si)]?.fields?.[name];
}

function showCfg(si)      { return archField(si, 'cfgScale'); }
function showGuidance(si) { return archField(si, 'guidance'); }
function showNegative(si) { return archField(si, 'negativePrompt'); }

function addGenerateStep() { form.steps.push(blankGenerateStep()); }
function addUpscaleStep()  { form.steps.push(blankUpscaleStep()); }
function addVideoStep()    { form.steps.push(blankVideoStep()); }
function removeStep(si)    { form.steps.splice(si, 1); }

const hasVideoStep = computed(() => form.steps.some(s => s.type === 'video'));

const videoModels = computed(() =>
  Object.entries(props.config.models ?? {})
    .filter(([, m]) => props.archMeta[m.architecture]?.videoArch)
    .map(([id, m]) => ({ id, label: m.label || id }))
);

async function save() {
  if (!form.label.trim()) return alert('Enter a name for this workflow.');
  if (!form.steps.length) return alert('Add at least one step.');

  if (form.steps.some(s => s.type === 'generate' && !s.modelId)) {
    return alert('Select a model for every generate step.');
  }
  if (form.steps.some(s => s.type === 'upscale' && s.upscaleType === 'model' && !s.upscaleModel)) {
    return alert('Select an upscale model for every model upscale step.');
  }
  if (form.steps.some(s => s.type === 'upscale' && s.upscaleType === 'hires' && !s.modelId)) {
    return alert('Select a model for every hires upscale step.');
  }
  if (form.steps.some(s => s.type === 'video' && !s.modelId)) {
    return alert('Select a video model for the video step.');
  }
  const videoIdx = form.steps.findIndex(s => s.type === 'video');
  if (videoIdx !== -1 && videoIdx !== form.steps.length - 1) {
    return alert('The video step must be the last step in the workflow.');
  }

  const steps = form.steps.map((s, si) => {
    const review = {
      ...(s.maxIterations !== '' && { maxIterations: Number(s.maxIterations) }),
      ...(s.gracePeriod   !== '' && { gracePeriod:   Number(s.gracePeriod) }),
      humanReview: s.humanReview,
    };

    if (s.type === 'upscale') {
      if (s.upscaleType === 'hires') {
        return {
          type: 'upscale', upscaleType: 'hires',
          modelId:  s.modelId,
          scale:    s.scale ?? 2,
          denoise:  s.denoise !== '' ? Number(s.denoise) : undefined,
          ...(s.steps    !== '' && { steps:    Number(s.steps) }),
          ...(s.cfgScale !== '' && { cfgScale: Number(s.cfgScale) }),
          ...(s.sampler            && { sampler:    s.sampler }),
          ...(s.scheduler          && { scheduler:  s.scheduler }),
          review,
        };
      }
      return {
        type: 'upscale', upscaleType: 'model',
        upscaleModel: s.upscaleModel,
        factor:       s.factor ?? 4,
        review,
      };
    }

    if (s.type === 'video') {
      return {
        type:    'video',
        modelId: s.modelId,
        params: {
          ...(s.width    !== '' && { width:    Number(s.width) }),
          ...(s.height   !== '' && { height:   Number(s.height) }),
          ...(s.frames   !== '' && { frames:   Number(s.frames) }),
          ...(s.fps      !== '' && { fps:      Number(s.fps) }),
          ...(s.steps    !== '' && { steps:    Number(s.steps) }),
          ...(s.guidance !== '' && { guidance: Number(s.guidance) }),
          ...(s.cfgScale !== '' && { cfgScale: Number(s.cfgScale) }),
        },
      };
    }

    const caps = capsForModel(s.modelId);
    // Fall back to txt2img if the chosen mode requires a capability the model lacks
    const imageMode = (s.imageMode === 'adapter'    && !caps.adapter)            ? 'txt2img'
                    : (s.imageMode === 'tile'        && !caps.tileControlNet)     ? 'txt2img'
                    : (s.imageMode === 'structural'  && !caps.structuralControlNet) ? 'txt2img'
                    : (s.imageMode || 'txt2img');

    // Chain strategy (only meaningful when not the first step)
    const chainStrategy = si > 0 ? {
      mode: imageMode,
      ...((imageMode === 'init-image' || imageMode === 'tile') && s.imageDenoise !== '' && { denoise: Number(s.imageDenoise) }),
      ...(imageMode === 'tile'       && s.imageStrength !== '' && { tileStrength:  Number(s.imageStrength) }),
      ...(imageMode === 'structural' && s.imageStrength !== '' && { strength:      Number(s.imageStrength) }),
    } : undefined;

    // ControlNet: pose and/or tile-from-references
    const controlNetOut = {};
    if (caps.controlNet && s.poseMode !== 'off') {
      controlNetOut.poseMode = s.poseMode;
      controlNetOut.strength = Number(s.cnStrength) || 1.0;
    }
    if (caps.tileControlNet && imageMode === 'tile') {
      controlNetOut.tile = {
        enabled: true,
        ...(s.imageStrength !== '' && { strength: Number(s.imageStrength) }),
        ...(s.imageDenoise  !== '' && { denoise:  Number(s.imageDenoise) }),
      };
    }

    return {
      type:    'generate',
      modelId: s.modelId,
      params: {
        ...(s.width          !== '' && { width:          Number(s.width) }),
        ...(s.height         !== '' && { height:         Number(s.height) }),
        ...(s.steps          !== '' && { steps:          Number(s.steps) }),
        ...(s.cfgScale       !== '' && { cfgScale:       Number(s.cfgScale) }),
        ...(s.guidance       !== '' && { guidance:       Number(s.guidance) }),
        ...(s.sampler              && { sampler:         s.sampler }),
        ...(s.scheduler            && { scheduler:       s.scheduler }),
        ...(s.negativePrompt       && { negativePrompt:  s.negativePrompt }),
        ...(s.refinerSwitchAt !== '' && { refinerSwitchAt: Number(s.refinerSwitchAt) }),
      },
      ...(chainStrategy && { chainStrategy }),
      review,
      referenceStrategy: {
        visionNotes: s.visionNotes,
        diffusion: {
          // tile/structural use CN nodes rather than diffusion routing; record as txt2img
          mode: (imageMode === 'tile' || imageMode === 'structural') ? 'txt2img' : imageMode,
          ...(imageMode === 'init-image' && { denoise: Number(s.imageDenoise) || 0.6 }),
        },
      },
      ...(caps.lora && s.loras.some(l => l.name) && { loras: s.loras.filter(l => l.name).map(l => ({ name: l.name, weight: Number(l.weight) || 1.0 })) }),
      llmLoras: caps.lora ? s.llmLoras : false,
      ...(Object.keys(controlNetOut).length && { controlNet: controlNetOut }),
    };
  });

  await saveWorkflow(props.workflowId, { label: form.label.trim(), steps });
  emit('saved');
}

async function remove() {
  if (!confirm(`Delete "${props.workflow?.label}"?`)) return;
  await deleteWorkflow(props.workflowId);
  emit('deleted');
}
</script>

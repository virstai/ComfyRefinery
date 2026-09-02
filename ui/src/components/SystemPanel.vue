<template>
  <div style="flex:1;overflow-y:auto;padding:20px 24px">
    <div class="panel-header">
      <h2>System</h2>
      <button class="small secondary" :disabled="loading" @click="load">↻ Refresh</button>
    </div>
    <div v-if="loading && !info" style="color:var(--muted);font-size:13px">Inspecting ComfyUI…</div>
    <div v-else-if="error" style="color:var(--reject);font-size:13px">{{ error }}</div>
    <template v-else-if="info">

      <!-- ComfyUI + LLM -->
      <div class="sys-grid">
        <div class="sys-card">
          <div class="sys-card-title">ComfyUI <span class="sess-status" :class="info.comfyui.reachable ? 'sess-complete' : 'sess-error'">{{ info.comfyui.reachable ? 'reachable' : 'unreachable' }}</span></div>
          <div class="sys-kv"><span>URL</span><code>{{ info.comfyui.url }}</code></div>
          <template v-if="info.comfyui.reachable">
            <div class="sys-kv"><span>Version</span><span>{{ info.comfyui.version }}</span></div>
            <div class="sys-kv"><span>PyTorch</span><span>{{ info.comfyui.pytorch }}</span></div>
            <div class="sys-kv"><span>Python</span><span>{{ info.comfyui.python }} · {{ info.comfyui.os }}</span></div>
            <div class="sys-kv"><span>System RAM</span><span>{{ gb(info.comfyui.ramFree) }} free of {{ gb(info.comfyui.ramTotal) }}</span></div>
            <div class="sys-kv"><span>Launch args</span><code class="sys-argv">{{ info.comfyui.argv.slice(1).join(' ') || '—' }}</code></div>
            <div class="sys-kv" v-for="p in info.comfyui.packages" :key="p.name"><span>{{ p.name }}</span><span :class="{ 'sys-warn': p.installed !== p.required }">{{ p.installed }}<template v-if="p.installed !== p.required"> (wants {{ p.required }})</template></span></div>
          </template>
          <div v-else class="hint">{{ info.comfyui.error }}</div>
        </div>
        <div class="sys-card">
          <div class="sys-card-title">GPUs <span class="sess-status" :class="info.comfyui.multiGpu ? 'sess-complete' : 'sess-error'">{{ info.comfyui.multiGpu ? 'placement available' : 'no MultiGPU nodes' }}</span></div>
          <div v-if="!info.comfyui.devices.length" class="hint">No GPU reported by ComfyUI.</div>
          <div class="sys-kv" v-for="d in info.comfyui.devices" :key="d.id"><span><code>{{ d.id }}</code></span><span>{{ d.name }} · {{ gb(d.vramFree) }} free of {{ gb(d.vramTotal) }}</span></div>
          <p class="hint" style="margin-top:8px">Only GPUs visible to ComfyUI's process are listed (HIP_VISIBLE_DEVICES / CUDA_VISIBLE_DEVICES / --cuda-device). Free values are ComfyUI's own view and ignore other processes on the card.</p>
        </div>
        <div class="sys-card">
          <div class="sys-card-title">LLM <span class="sess-status" :class="info.llm.reachable ? 'sess-complete' : 'sess-error'">{{ info.llm.reachable ? 'reachable' : 'unreachable' }}</span></div>
          <div class="sys-kv"><span>Base URL</span><code>{{ info.llm.baseUrl }}</code></div>
          <div class="sys-kv"><span>Model</span><span>{{ info.llm.model || '— not set —' }}</span></div>
          <div class="sys-kv"><span>Available</span><span>{{ info.llm.models.length }} model{{ info.llm.models.length === 1 ? '' : 's' }}</span></div>
          <div v-if="info.llm.error" class="hint">{{ info.llm.error }}</div>
        </div>
      </div>

      <!-- Architectures -->
      <h3 class="sys-h3">Architectures</h3>
      <p class="hint" style="margin-bottom:8px">Each architecture's base graph is built and every node it needs is checked against this ComfyUI. Optional packs unlock extra modes for that architecture.</p>
      <table class="sys-table">
        <thead><tr><th>Architecture</th><th>Status</th><th>Needs</th><th>Optional</th></tr></thead>
        <tbody>
          <tr v-for="a in info.archs" :key="a.arch">
            <td><strong>{{ a.label }}</strong><div class="list-row-meta">{{ a.arch }}{{ a.videoArch ? ' · video' : '' }}{{ a.minVersion ? ` · ComfyUI ≥ ${a.minVersion}` : '' }}</div></td>
            <td>
              <span class="sess-status" :class="a.available ? 'sess-complete' : (a.nodes ? 'sess-error' : 'sess-running')">{{ a.available ? 'available' : (a.nodes ? 'missing nodes' : 'unknown') }}</span>
              <div v-if="!a.coreOk" class="list-row-meta sys-warn">ComfyUI {{ info.comfyui.version }} is older than {{ a.minVersion }}</div>
              <div v-if="a.missingNodes.length" class="list-row-meta" :title="a.missingNodes.join(', ')">missing: {{ a.missingNodes.slice(0, 3).join(', ') }}{{ a.missingNodes.length > 3 ? ` +${a.missingNodes.length - 3}` : '' }}</div>
            </td>
            <td>
              <span v-if="!a.requiredPacks.length" class="list-row-meta">core nodes only</span>
              <div v-for="p in a.requiredPacks" :key="p.id" class="list-row-meta"><span class="sys-dot" :class="p.installed ? 'ok' : 'bad'"></span>{{ p.label }}</div>
            </td>
            <td>
              <div v-for="p in a.optionalPacks" :key="p.id" class="list-row-meta" :title="p.features.join('; ')"><span class="sys-dot" :class="p.installed ? 'ok' : 'off'"></span>{{ p.label }} — {{ p.features[0] }}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Node packs -->
      <h3 class="sys-h3">Custom node packs</h3>
      <table class="sys-table">
        <thead><tr><th>Pack</th><th>Status</th><th>Enables</th></tr></thead>
        <tbody>
          <tr v-for="p in info.packs" :key="p.id">
            <td><a :href="p.url" target="_blank" rel="noopener">{{ p.label }}</a><div v-if="p.modules.length" class="list-row-meta">{{ p.modules.map(m => m.replace(/^custom_nodes\./, '')).join(', ') }}</div></td>
            <td>
              <span class="sess-status" :class="p.installed ? 'sess-complete' : (isRequired(p) ? 'sess-error' : 'sess-running')">{{ p.installed ? 'installed' : (isRequired(p) ? 'missing · required' : 'not installed') }}</span>
              <div v-if="!p.installed && (p.missingNodes.length || p.missingSamplers.length)" class="list-row-meta" :title="[...p.missingNodes, ...p.missingSamplers].join(', ')">missing {{ p.missingNodes.length ? `${p.missingNodes.length} node${p.missingNodes.length === 1 ? '' : 's'}` : '' }}{{ p.missingSamplers.length ? ` sampler ${p.missingSamplers.join(', ')}` : '' }}</div>
            </td>
            <td><div v-for="f in p.features" :key="f.feature" class="list-row-meta"><strong>{{ f.archs.includes('*') ? 'all' : f.archs.join(', ') }}</strong> — {{ f.feature }}{{ f.required ? ' (required)' : '' }}</div></td>
          </tr>
        </tbody>
      </table>
      <p class="hint" style="margin-top:6px">Versions are not exposed by ComfyUI's API — update packs from ComfyUI-Manager or git. Other packs ComfyUI loaded:
        <span v-if="!otherPacks.length">none</span><span v-for="(p, i) in otherPacks" :key="p.name">{{ i ? ', ' : '' }}{{ p.name }} ({{ p.nodeCount }})</span>
      </p>

      <!-- Model files -->
      <h3 class="sys-h3">Model files</h3>
      <p class="hint" style="margin-bottom:8px">Tag files with the architectures they belong to. Once any file of a kind is tagged for an architecture, that architecture's model settings only list the tagged files.</p>
      <div class="sys-filters">
        <select v-model="kind">
          <option v-for="k in fileKinds" :key="k" :value="k">{{ kindLabel(k) }} ({{ (info.files[k] ?? []).length }})</option>
        </select>
        <input v-model="search" placeholder="filter by name…" style="flex:1">
        <label class="checkbox-label" style="margin:0"><input type="checkbox" v-model="untaggedOnly"> untagged only</label>
      </div>
      <div v-if="!filteredFiles.length" class="hint">No files.</div>
      <div v-for="f in filteredFiles" :key="f" class="sys-file">
        <span class="sys-file-name" :title="f">{{ f }}</span>
        <span class="sys-chips">
          <button v-for="a in info.architectures" :key="a" class="chip" :class="{ on: tagsFor(f).includes(a) }" :disabled="saving === tagKey(f)" @click="toggle(f, a)">{{ a }}</button>
        </span>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { configState } from '../stores/config.js';

const info    = ref(null);
const loading = ref(false);
const error   = ref(null);
const kind    = ref('checkpoints');
const search  = ref('');
const untaggedOnly = ref(false);
const saving  = ref(null);

const KIND_LABELS = { checkpoints: 'Checkpoints', unets: 'UNets / diffusion models', clips: 'Text encoders', vaes: 'VAEs', loras: 'LoRAs', upscaleModels: 'Upscale models', ipAdapterModels: 'IP-Adapter models', clipVisionModels: 'CLIP Vision', reduxModels: 'Redux / style models', controlNets: 'ControlNets' };
const kindLabel = k => KIND_LABELS[k] ?? k;

const fileKinds = computed(() => Object.keys(info.value?.files ?? {}).filter(k => Array.isArray(info.value.files[k])));
const otherPacks = computed(() => (info.value?.installedPacks ?? []).filter(p => !p.known));
const isRequired = p => p.features.some(f => f.required);

const tagKey  = f => `${kind.value}:${f}`;
const tagsFor = f => info.value?.fileArchTags?.[tagKey(f)] ?? [];
const filteredFiles = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (info.value?.files?.[kind.value] ?? []).filter(f => (!q || f.toLowerCase().includes(q)) && (!untaggedOnly.value || !tagsFor(f).length));
});

async function toggle(f, arch) {
  const key  = tagKey(f);
  const cur  = tagsFor(f);
  const next = cur.includes(arch) ? cur.filter(a => a !== arch) : [...cur, arch];
  saving.value = key;
  try {
    const tags = await api('PUT', '/api/system/file-tags', { key, archs: next });
    info.value.fileArchTags = tags;
    configState.config.fileArchTags = tags;   // model editors filter off this
  } catch (e) {
    error.value = e.message;
  } finally {
    saving.value = null;
  }
}

async function load() {
  loading.value = true; error.value = null;
  try {
    info.value = await api('GET', '/api/system/info');
    if (!fileKinds.value.includes(kind.value)) kind.value = fileKinds.value[0] ?? 'checkpoints';
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function gb(bytes) { return bytes == null ? '?' : `${(bytes / 2 ** 30).toFixed(1)} GB`; }

onMounted(load);
</script>

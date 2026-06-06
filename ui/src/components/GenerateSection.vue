<template>
  <div
    class="prompt-bar"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="e => { dragging = false; uploadFiles(e.dataTransfer.files); }"
  >
    <textarea
      v-model="genState.prompt"
      placeholder="Describe the image you want…"
      rows="3"
    ></textarea>

    <div class="prompt-bar-actions">
      <!-- Inline reference strip -->
      <div class="prompt-bar-refs">
        <div
          v-for="(ref, i) in genState.references"
          :key="ref.filename + i"
          class="prompt-bar-ref-thumb"
        >
          <img :src="refUrl(ref)" :alt="`ref ${i + 1}`">
          <div class="prompt-bar-ref-remove" @click="removeRef(i)">✕</div>
        </div>
        <div
          class="prompt-bar-ref-add"
          :title="uploading ? 'Uploading…' : 'Add reference images'"
          @click="!uploading && fileInput.click()"
        >
          <span v-if="uploading" style="font-size:11px;color:var(--muted)">…</span>
          <span v-else>+</span>
        </div>
        <input ref="fileInput" type="file" multiple accept="image/*" style="display:none" @change="onFileInput">
      </div>

      <!-- Session indicator -->
      <div v-if="loadedDesc" class="prompt-bar-session">
        <span class="prompt-bar-session-label">{{ truncate(loadedDesc, 50) }}</span>
        <button class="secondary small" @click="clearAndReset">New</button>
      </div>

      <button
        id="btn-continue"
        v-if="sessionId"
        class="secondary small"
        :disabled="running || uploading"
        @click="$emit('continue', sessionId, references)"
        style="white-space:nowrap"
      >Continue</button>

      <button
        id="btn-generate"
        class="primary"
        :disabled="running || uploading"
        @click="generate"
        style="white-space:nowrap"
      >{{ running ? 'Running…' : 'Generate' }}</button>
    </div>

    <!-- Drop zone overlay -->
    <div
      v-if="dragging"
      style="position:absolute;inset:0;background:color-mix(in srgb,var(--accent) 10%,transparent);border:2px dashed var(--accent);border-radius:var(--radius);pointer-events:none"
    ></div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { genState } from '../stores/generate.js';

const props = defineProps({
  running:    { type: Boolean, default: false },
  sessionId:  { type: String,  default: null },
  loadedDesc: { type: String,  default: null },
  config:     { type: Object,  default: () => ({}) },
});

const emit = defineEmits(['generate', 'continue', 'clear', 'open-workflows', 'open-settings']);

const dragging  = ref(false);
const uploading = ref(false);
const fileInput = ref(null);

function refUrl(ref) {
  return `/api/image?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder ?? '')}&type=${encodeURIComponent(ref.type ?? 'input')}`;
}

async function uploadFiles(files) {
  if (!files.length) return;
  uploading.value = true;
  try {
    const encoded = await Promise.all(Array.from(files).map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve({ name: file.name, data: reader.result });
      reader.onerror = reject;
      reader.readAsDataURL(file);
    })));
    const res = await fetch('/api/references/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: encoded }),
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.statusText}`);
    genState.references.push(...await res.json());
  } catch (err) {
    alert(`Reference upload failed: ${err.message}`);
  } finally {
    uploading.value = false;
    dragging.value  = false;
  }
}

function onFileInput(e) { uploadFiles(e.target.files); e.target.value = ''; }
function removeRef(i)   { genState.references.splice(i, 1); }

function generate() {
  const desc = genState.prompt.trim();
  if (!desc) return alert('Enter a description first.');
  if (!props.config.activeWorkflow) { emit('open-workflows'); return alert('Select an active workflow first.'); }
  if (!props.config.llmModel)       { emit('open-settings');  return alert('Set an LLM model in Settings first.'); }
  emit('generate', desc, genState.references);
}

function clearAndReset() {
  emit('clear');
}

function truncate(s, n) { return s?.length > n ? s.slice(0, n) + '…' : s; }
</script>

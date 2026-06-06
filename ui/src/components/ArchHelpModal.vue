<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal" style="max-width:700px;">
      <div class="modal-header">
        <span class="modal-title">{{ archLabel }} — Setup Guide</span>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>
      <div style="padding:20px 24px; overflow-y:auto; max-height:calc(90vh - 52px);">
        <div v-if="loading" style="color:var(--muted); font-size:13px;">Loading…</div>
        <div v-else-if="error"   style="color:var(--muted); font-size:13px;">{{ error }}</div>
        <div v-else class="arch-help-body" v-html="renderedHtml"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { Marked } from 'marked';

const props = defineProps({
  arch:      { type: String, required: true },
  archLabel: { type: String, default: 'Architecture' },
});
defineEmits(['close']);

const localMarked = new Marked({
  renderer: {
    link({ href, text }) {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

const loading      = ref(true);
const error        = ref(null);
const renderedHtml = ref('');

onMounted(async () => {
  try {
    const res = await fetch(`/api/arch-help/${props.arch}`);
    if (res.status === 404) {
      error.value = 'No setup guide available for this architecture yet.';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    renderedHtml.value = localMarked.parse(md);
  } catch {
    error.value = 'Could not load the setup guide.';
  } finally {
    loading.value = false;
  }
});
</script>

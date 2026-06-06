<template>
  <div style="flex:1;overflow-y:auto;padding:20px 24px">
    <div class="panel-header">
      <h2>Session History</h2>
    </div>

    <div v-if="loading" style="color:var(--muted);font-size:13px">Loading…</div>
    <div v-else-if="error"   style="color:var(--reject);font-size:13px">{{ error }}</div>
    <div v-else-if="!sessions.length" style="color:var(--muted);font-size:13px">No sessions yet.</div>

    <div v-else id="session-list">
      <div v-for="s in sessions" :key="s.id" class="sess-row">
        <div class="sess-info">
          <span class="sess-desc">{{ truncate(s.prompt, 80) }}</span>
          <span class="sess-meta">{{ s.workflowLabel ?? '—' }} &middot; {{ s.iterationCount }} iter &middot; {{ formatDate(s.updatedAt ?? s.createdAt) }}</span>
        </div>
        <span class="sess-status" :class="statusClass(s.status)">{{ s.status }}</span>
        <div class="sess-actions">
          <button class="small secondary" @click="load(s.id)">Load</button>
          <button class="small danger" @click="remove(s.id)">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['load-session']);

const sessions = ref([]);
const loading  = ref(true);
const error    = ref(null);

onMounted(async () => {
  try {
    sessions.value = await api('GET', '/api/generate/sessions');
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

function load(id) {
  emit('load-session', id);
}

async function remove(id) {
  if (!confirm('Delete this session?')) return;
  try {
    await api('DELETE', `/api/generate/sessions/${id}`);
    sessions.value = sessions.value.filter(s => s.id !== id);
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

function truncate(s, n) {
  return s?.length > n ? s.slice(0, n) + '…' : s;
}

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function statusClass(status) {
  return { complete: 'sess-complete', running: 'sess-running', error: 'sess-error' }[status] ?? '';
}
</script>

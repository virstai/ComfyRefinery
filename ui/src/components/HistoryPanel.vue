<template>
  <div style="flex:1;overflow-y:auto;padding:20px 24px">
    <div class="panel-header">
      <h2>Session History</h2>
    </div>

    <div class="history-actions">
      <button class="small secondary" @click="clearByStatus('running')" title="Delete sessions stuck in running state">Clear stuck</button>
      <button class="small secondary" @click="clearByStatus('error')"   title="Delete all error sessions">Clear errors</button>
      <button class="small danger"    @click="clearAll"                  title="Delete all sessions">Clear all</button>
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

async function loadSessions() {
  loading.value = true;
  error.value   = null;
  try {
    sessions.value = await api('GET', '/api/generate/sessions');
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

onMounted(loadSessions);

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

async function clearByStatus(status) {
  const label = status === 'running' ? 'stuck running' : `${status}`;
  if (!confirm(`Delete all ${label} sessions?`)) return;
  try {
    const result = await api('DELETE', `/api/generate/sessions?status=${status}`);
    alert(`Deleted ${result.deleted} session(s).`);
    await loadSessions();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

async function clearAll() {
  if (!confirm('Delete ALL sessions? This cannot be undone.')) return;
  try {
    const result = await api('DELETE', '/api/generate/sessions?status=all');
    alert(`Deleted ${result.deleted} session(s).`);
    await loadSessions();
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

<style scoped>
.history-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
</style>

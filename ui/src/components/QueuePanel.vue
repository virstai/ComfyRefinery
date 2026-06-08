<template>
  <div style="flex:1;overflow-y:auto;padding:20px 24px">
    <div class="panel-header">
      <h2>Queue</h2>
    </div>

    <!-- Running -->
    <div class="queue-section">
      <h3 class="queue-section-title">Running</h3>
      <div v-if="state.running" class="queue-job queue-job--running">
        <div class="queue-job-info">
          <span class="queue-job-prompt">{{ truncate(state.running.prompt, 80) }}</span>
          <span class="queue-job-meta">
            {{ state.running.workflowId }}
            <span v-if="state.running.refCount"> · {{ state.running.refCount }} ref{{ state.running.refCount !== 1 ? 's' : '' }}</span>
            · {{ elapsed(state.running.startedAt) }}
          </span>
        </div>
        <button class="small danger" @click="stop(state.running.id)">■ Stop</button>
      </div>
      <div v-else class="queue-empty">Nothing running</div>
    </div>

    <!-- Pending -->
    <div class="queue-section">
      <h3 class="queue-section-title">Pending</h3>
      <div v-if="state.pending.length === 0" class="queue-empty">No requests queued</div>
      <div v-for="(job, i) in state.pending" :key="job.id" class="queue-job">
        <div class="queue-job-info">
          <span class="queue-job-pos">#{{ i + 1 }}</span>
          <span class="queue-job-prompt">{{ truncate(job.prompt, 70) }}</span>
          <span class="queue-job-meta">
            {{ job.workflowId }}
            <span v-if="job.refCount"> · {{ job.refCount }} ref{{ job.refCount !== 1 ? 's' : '' }}</span>
            · queued {{ elapsed(job.queuedAt) }}
          </span>
        </div>
        <button class="small secondary" @click="cancel(job.id)">✕ Cancel</button>
      </div>
    </div>

    <!-- Done (this session) -->
    <div class="queue-section">
      <h3 class="queue-section-title">Done (this session)</h3>
      <div v-if="state.done.length === 0" class="queue-empty">No completed jobs yet</div>
      <div v-for="job in [...state.done].reverse()" :key="job.id" class="queue-job">
        <img v-if="job.outputImageUrl" :src="job.outputImageUrl" class="queue-thumb" />
        <div class="queue-job-info">
          <span class="queue-job-prompt">{{ truncate(job.prompt, 70) }}</span>
          <span class="queue-job-meta">
            {{ job.workflowId }}
            · {{ durationMs(job.startedAt, job.finishedAt) }}
          </span>
        </div>
        <span class="queue-badge" :class="badgeClass(job.status)">{{ job.status }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

const state = ref({ pending: [], running: null, done: [] });
let es = null;
let ticker = null;
const now = ref(Date.now());

onMounted(async () => {
  // Fetch initial state
  try {
    const res = await fetch('/api/queue');
    if (res.ok) state.value = await res.json();
  } catch { /* ignore */ }

  // Subscribe to live updates
  es = new EventSource('/api/queue/events');
  es.addEventListener('state', e => {
    try { state.value = JSON.parse(e.data); } catch { /* ignore */ }
  });

  // Tick every second to update elapsed times
  ticker = setInterval(() => { now.value = Date.now(); }, 1000);
});

onBeforeUnmount(() => {
  es?.close();
  clearInterval(ticker);
});

async function cancel(id) {
  await fetch(`/api/queue/${id}`, { method: 'DELETE' }).catch(() => {});
}

async function stop(id) {
  await fetch(`/api/queue/${id}/stop`, { method: 'POST' }).catch(() => {});
}

function truncate(s, n) {
  return s?.length > n ? s.slice(0, n) + '…' : (s ?? '');
}

function elapsed(iso) {
  if (!iso) return '';
  const secs = Math.floor((now.value - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function durationMs(startIso, endIso) {
  if (!startIso || !endIso) return '';
  const secs = Math.round((new Date(endIso) - new Date(startIso)) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function badgeClass(status) {
  return {
    'queue-badge--done':      status === 'done',
    'queue-badge--error':     status === 'error',
    'queue-badge--cancelled': status === 'cancelled',
  };
}
</script>

<style scoped>
.queue-section { margin-bottom: 28px; }
.queue-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 10px; }
.queue-empty { font-size: 13px; color: var(--muted); }
.queue-job { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.queue-job:last-child { border-bottom: none; }
.queue-job--running { background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 6px; padding: 10px; margin: 0 -10px; }
.queue-job-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.queue-job-pos { font-size: 11px; font-weight: 700; color: var(--muted); }
.queue-job-prompt { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-job-meta { font-size: 11px; color: var(--muted); }
.queue-thumb { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.queue-badge { font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; background: var(--border); align-self: center; flex-shrink: 0; }
.queue-badge--done { background: color-mix(in srgb, var(--accept) 20%, transparent); color: var(--accept); }
.queue-badge--error { background: color-mix(in srgb, var(--reject) 20%, transparent); color: var(--reject); }
.queue-badge--cancelled { background: color-mix(in srgb, var(--muted) 20%, transparent); color: var(--muted); }
</style>

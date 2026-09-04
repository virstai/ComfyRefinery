<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal picker">
      <div class="modal-header">
        <span class="modal-title">Pick an image from a session</span>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>
      <div class="picker-body">
        <div class="picker-list">
          <div v-if="loading" class="hint" style="padding:8px">Loading…</div>
          <div v-else-if="!sessions.length" class="hint" style="padding:8px">No sessions.</div>
          <div v-for="s in sessions" :key="s.id" class="list-row" :class="{ selected: s.id === sessionId }" @click="open(s.id)">
            <div class="list-row-name">{{ truncate(s.prompt, 60) }}</div>
            <div class="list-row-meta">{{ s.workflowLabel ?? '—' }} · {{ formatDate(s.updatedAt ?? s.createdAt) }}</div>
          </div>
        </div>
        <div class="picker-variants">
          <div v-if="!sessionId" class="hint" style="padding:8px">Select a session on the left.</div>
          <div v-else-if="loadingSession" class="hint" style="padding:8px">Loading…</div>
          <template v-else>
            <div v-for="(step, si) in imageSteps" :key="si" class="picker-step">
              <div class="hint" style="margin-bottom:6px">Step {{ step.index + 1 }} · {{ step.label }}</div>
              <div class="iter-grid">
                <IterationCard
                  v-for="it in step.iterations"
                  :key="it.n"
                  :iteration="it"
                  @open="pick(it)"
                />
              </div>
            </div>
            <div v-if="!imageSteps.length" class="hint" style="padding:8px">No image variants in this session.</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import IterationCard from '../IterationCard.vue';
import { api } from '../../api.js';

const emit = defineEmits(['pick', 'close']);

const sessions       = ref([]);
const loading        = ref(true);
const sessionId      = ref(null);
const session        = ref(null);
const loadingSession = ref(false);

onMounted(async () => {
  try { sessions.value = await api('GET', '/api/generate/sessions'); }
  catch (err) { console.warn(err); }
  finally { loading.value = false; }
});

async function open(id) {
  sessionId.value = id;
  loadingSession.value = true;
  try { session.value = await api('GET', `/api/generate/sessions/${id}`); }
  catch (err) { alert(`Could not load session: ${err.message}`); }
  finally { loadingSession.value = false; }
}

const imageSteps = computed(() => (session.value?.steps ?? [])
  .map((step, index) => ({
    index, label: step.label,
    iterations: (step.iterations ?? []).map((it, i) => ({ n: i + 1, imageUrl: it.imageUrl, verdict: it.verdict, status: '', progress: 100 })).filter(it => it.imageUrl),
  }))
  .filter(s => s.iterations.length));

function pick(it) {
  emit('pick', { sessionId: sessionId.value, imageUrl: it.imageUrl });
}
function truncate(s, n) { return s?.length > n ? s.slice(0, n) + '…' : (s ?? ''); }
function formatDate(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }
</script>

<style scoped>
.picker { width: min(960px, 92vw); height: min(640px, 86vh); display: flex; flex-direction: column; }
.picker-body { display: flex; flex: 1; min-height: 0; }
.picker-list { width: 280px; flex-shrink: 0; border-right: 1px solid var(--border); overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.picker-variants { flex: 1; overflow-y: auto; padding: 12px; }
.picker-step { margin-bottom: 14px; }
</style>

<template>
  <div class="pipeline-detail">
    <div class="detail-pane-header">
      <template v-if="displayed">
        <div>
          <div class="detail-pane-title">{{ displayed.isVideo ? 'Video Output' : `Iteration #${displayed.iteration.n}` }}</div>
          <div class="detail-pane-subtitle">{{ displayed.stepLabel }}</div>
        </div>
      </template>
      <template v-else>
        <div class="detail-pane-title">Detail</div>
      </template>

      <div
        class="active-badge"
        :class="pinnedKey ? 'is-pinned' : 'is-active'"
        @click="unpin"
        :title="pinnedKey ? 'Click to follow active iteration' : 'Auto-following active iteration'"
      >
        <span class="active-badge-dot"></span>
        {{ pinnedKey ? 'Pinned' : 'Active' }}
      </div>
    </div>

    <div class="detail-pane-body">
      <div v-if="!displayed" class="detail-pane-empty">
        {{ running ? 'Waiting for first iteration…' : 'No iteration selected' }}
      </div>

      <template v-else-if="displayed.isVideo">
        <!-- Video step -->
        <div class="detail-image-wrap">
          <video
            v-if="displayed.videoUrl"
            :src="displayed.videoUrl"
            controls loop
            style="width:100%;border-radius:4px"
          ></video>
          <div v-else class="detail-image-placeholder">
            Generating… {{ displayed.progress || 0 }}%
            <div v-if="displayed.progress > 0" class="detail-progress-overlay">
              <div class="detail-progress-fill" :style="{ width: displayed.progress + '%' }"></div>
            </div>
          </div>
        </div>
        <div class="detail-info">
          <div class="detail-field">
            <label>Status</label>
            <div class="val">
              <span v-if="displayed.videoUrl" class="verdict accept">Complete</span>
              <span v-else class="iter-status">Generating…</span>
            </div>
          </div>
          <div v-if="displayed.progress > 0 && !displayed.videoUrl" class="detail-field">
            <label>Progress</label>
            <div class="progress-bar" style="height:4px">
              <div class="fill" :style="{ width: displayed.progress + '%' }"></div>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <!-- Image iteration -->
        <div class="detail-image-wrap">
          <img
            v-if="displayed.iteration.imageUrl"
            :src="displayed.iteration.imageUrl"
            :alt="`Iteration ${displayed.iteration.n}`"
          >
          <div v-else class="detail-image-placeholder">
            {{ displayed.iteration.status || 'Waiting…' }}
            <div v-if="showProgress" class="detail-progress-overlay">
              <div class="detail-progress-fill" :style="{ width: displayed.iteration.progress + '%' }"></div>
            </div>
          </div>
        </div>

        <!-- Info -->
        <div class="detail-info">
          <!-- Verdict / status -->
          <div class="detail-field">
            <label>Status</label>
            <div class="val">
              <span
                v-if="displayed.iteration.verdict"
                class="verdict"
                :class="displayed.iteration.verdict.toLowerCase()"
              >{{ displayed.iteration.verdict }}</span>
              <span v-else class="iter-status">{{ displayed.iteration.status || '—' }}</span>
            </div>
          </div>

          <!-- Progress bar while generating -->
          <div v-if="showProgress" class="detail-field">
            <label>Progress</label>
            <div class="progress-bar" style="height:4px">
              <div class="fill" :style="{ width: displayed.iteration.progress + '%' }"></div>
            </div>
          </div>

          <!-- Prompt -->
          <div class="detail-field">
            <label>Prompt</label>
            <div class="val">{{ displayPrompt }}</div>
          </div>

          <!-- Review / diagnosis -->
          <div class="detail-field">
            <label>Review</label>
            <div class="val">{{ displayReview }}</div>
          </div>

          <!-- Human feedback (if submitted) -->
          <div v-if="displayed.iteration.humanFeedback" class="detail-field">
            <label>Human feedback</label>
            <div class="val">{{ displayed.iteration.humanFeedback }}</div>
          </div>
        </div>

        <!-- Human review controls -->
        <div v-if="displayed.iteration.humanPending" class="human-review">
          <span class="hr-ai-note">AI: {{ displayed.iteration.aiVerdict }} — {{ displayed.iteration.aiDiagnosis }}</span>
          <textarea
            v-model="feedback"
            class="hr-feedback"
            placeholder="Optional feedback to guide the next iteration…"
            rows="2"
          ></textarea>
          <div class="hr-actions">
            <button class="primary"   :disabled="submitting" @click="submitReview(true)">Accept</button>
            <button class="secondary" :disabled="submitting" @click="submitReview(false)">Reject &amp; continue</button>
          </div>
        </div>

        <!-- Grace period controls -->
        <div v-if="displayed.iteration.acceptedPending" class="human-review">
          <span class="hr-ai-note">
            {{ displayed.iteration.graceMaxIterations
              ? `Max iterations reached — ${displayed.iteration.gracePeriod}s to refuse and keep iterating.`
              : `Accepted — ${displayed.iteration.gracePeriod}s grace period. Refuse to keep iterating.` }}
          </span>
          <div class="hr-actions">
            <button class="danger" :disabled="submitting" @click="refuse">Refuse &amp; continue</button>
          </div>
        </div>

        <!-- Refuse acceptance (post grace period, still ACCEPT) -->
        <div v-else-if="displayed.iteration.verdict === 'ACCEPT' && !displayed.iteration.acceptedPending" class="human-review">
          <div class="hr-actions">
            <button class="secondary" :disabled="submitting" @click="refuse">Refuse acceptance</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { submitHumanReview, refuseAccepted } from '../stores/generate.js';

const props = defineProps({
  steps:     { type: Array,   default: () => [] },
  running:   { type: Boolean, default: false },
  sessionId: { type: String,  default: null },
});

// pinnedKey: null = Active mode; { stepIndex, iterN } = Pinned mode
const pinnedKey  = ref(null);
const feedback   = ref('');
const submitting = ref(false);

const emit = defineEmits(['unpinned']);

// Expose pin/unpin/pinStep for RunSection to drive from card/video clicks
defineExpose({ pin, pinStep, unpin });

function pin(stepIndex, iterN) {
  pinnedKey.value = { stepIndex, iterN };
}
function pinStep(stepIndex) {
  pinnedKey.value = { stepIndex, iterN: null };
}
function unpin() {
  pinnedKey.value = null;
  emit('unpinned');
}

watch(pinnedKey, () => { feedback.value = ''; });

function videoEntry(step, i) {
  return { isVideo: true, videoUrl: step.videoUrl ?? null, progress: step.progress ?? 0, stepIndex: i, stepLabel: `${step.type} · ${step.label}` };
}

// Active entry: last step that is running or has output (video steps + iteration steps)
const activeEntry = computed(() => {
  for (let i = props.steps.length - 1; i >= 0; i--) {
    const step = props.steps[i];
    if (step.type === 'video') {
      if (step.videoUrl || step.progress > 0) return videoEntry(step, i);
      continue;
    }
    if (step.iterations.length) {
      const iter = step.iterations[step.iterations.length - 1];
      return { iteration: iter, stepIndex: i, stepLabel: `${step.type} · ${step.label}` };
    }
  }
  return null;
});

// Pinned entry: supports both iteration pins (iterN != null) and video step pins (iterN == null)
const pinnedEntry = computed(() => {
  if (!pinnedKey.value) return null;
  const step = props.steps[pinnedKey.value.stepIndex];
  if (!step) return null;
  if (step.type === 'video') return videoEntry(step, pinnedKey.value.stepIndex);
  const iter = step.iterations.find(it => it.n === pinnedKey.value.iterN);
  if (!iter) return null;
  return { iteration: iter, stepIndex: pinnedKey.value.stepIndex, stepLabel: `${step.type} · ${step.label}` };
});

const displayed = computed(() => pinnedKey.value ? pinnedEntry.value : activeEntry.value);

const showProgress = computed(() => {
  const d = displayed.value;
  if (!d || d.isVideo) return false;
  return d.iteration.progress > 0 && d.iteration.progress < 100;
});

const displayPrompt = computed(() => {
  const it = displayed.value?.iteration;
  return it?.prompt ?? (it?.streamingPrompt || '—');
});

const displayReview = computed(() => {
  const it = displayed.value?.iteration;
  return it?.fullReview ?? it?.diagnosis ?? (it?.streamingReview || '—');
});


async function submitReview(accept) {
  if (!props.sessionId || !displayed.value) return;
  submitting.value = true;
  try {
    await submitHumanReview(props.sessionId, displayed.value.stepIndex, accept, feedback.value.trim());
    feedback.value = '';
  } finally {
    submitting.value = false;
  }
}

async function refuse() {
  if (!props.sessionId || !displayed.value) return;
  submitting.value = true;
  try {
    await refuseAccepted(props.sessionId, displayed.value.stepIndex, displayed.value.iteration.n);
  } finally {
    submitting.value = false;
  }
}
</script>

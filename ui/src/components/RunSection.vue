<template>
  <div id="run-section" style="display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden">
    <div class="pipeline-area">
      <!-- Left: step grids -->
      <div class="pipeline-grids">
        <!-- Status box -->
        <div v-if="status" id="status-bar">
          <span id="status-text">{{ status }}</span>
          <span v-if="iterBadge" id="iteration-badge">{{ iterBadge }}</span>
        </div>
        <div
          v-for="step in steps"
          :key="step.index"
          class="step-group"
        >
          <div :class="['step-label', `type-${step.type}`]">
            <span class="step-type-badge">{{ step.type }}</span>
            {{ step.label || step.type }}
            <span v-if="canRerun" class="step-actions">
              <button class="step-action-btn" :title="step.type === 'video' ? 'New take using the previous step\'s selected image — nothing else is regenerated' : 'Generate a fresh variant of just this step — later steps are not run'" @click.stop="rerunFrom(sessionId, step.index, step.index)">↻ Redo</button>
              <button v-if="step.index < steps.length - 1" class="step-action-btn" title="Regenerate this step from scratch, then run everything after it. To reuse an existing image instead, click it and press “Use for … step”." @click.stop="rerunFrom(sessionId, step.index)">▶ From here</button>
            </span>
          </div>
          <!-- Legacy video step (no persisted takes): clickable thumbnail → pins into detail pane -->
          <template v-if="step.type === 'video' && !step.iterations.length">
            <div
              v-if="step.videoUrl"
              :class="['video-output', { selected: isPinnedStep(step.index) }]"
              @click="onVideoClick(step.index)"
              title="Click to view in detail pane"
            >
              <video :src="step.videoUrl" loop muted style="max-width:100%;border-radius:4px;pointer-events:none"></video>
            </div>
            <div v-else style="font-size:11px;color:var(--muted);padding:4px 0">
              <template v-if="step.progress > 0">
                Generating… {{ step.progress }}%
                <div class="video-progress-bar">
                  <div class="video-progress-fill" :style="{ width: step.progress + '%' }"></div>
                </div>
              </template>
              <template v-else>
                {{ step.status || 'Waiting…' }}
              </template>
            </div>
          </template>

          <!-- Iteration / take card grid -->
          <template v-else>
            <div v-if="!step.iterations.length" style="font-size:11px;color:var(--muted);padding:4px 0">
              Waiting…
            </div>
            <div v-else class="iter-grid">
              <IterationCard
                v-for="it in step.iterations"
                :key="it.n"
                :iteration="it"
                :selected="isPinned(step.index, it.n)"
                :is-output="isOutputCard(step, it)"
                @open="onCardClick(step.index, it.n)"
              />
            </div>
          </template>
        </div>
      </div>

      <!-- Right: detail pane -->
      <DetailPane
        ref="detailPane"
        :steps="steps"
        :running="running"
        :session-id="sessionId"
        @unpinned="onDetailUnpinned"
        @pinned="key => { pinnedKey = key; }"
      />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import IterationCard from './IterationCard.vue';
import DetailPane   from './DetailPane.vue';
import { rerunFrom } from '../stores/generate.js';

const props = defineProps({
  steps:     { type: Array,   default: () => [] },
  status:    { type: String,  default: '' },
  iterBadge: { type: String,  default: '' },
  sessionId: { type: String,  default: null },
  running:   { type: Boolean, default: false },
});

const detailPane = ref(null);
const pinnedKey  = ref(null); // { stepIndex, iterN } or null

const canRerun = computed(() => !!props.sessionId && !props.running);

// The variant that feeds the next step: the selected one, else the latest.
// Only badge it once there is an actual choice to make.
function isOutputCard(step, it) {
  if (step.iterations.length < 2) return false;
  const effective = step.selectedIteration ?? step.iterations.length;
  return it.n === effective && !!it.verdict;
}

function isPinned(stepIndex, iterN) {
  return pinnedKey.value?.stepIndex === stepIndex && pinnedKey.value?.iterN === iterN;
}

function isPinnedStep(stepIndex) {
  return pinnedKey.value?.stepIndex === stepIndex && pinnedKey.value?.iterN == null;
}

function onCardClick(stepIndex, iterN) {
  if (isPinned(stepIndex, iterN)) {
    pinnedKey.value = null;
    detailPane.value?.unpin();
  } else {
    pinnedKey.value = { stepIndex, iterN };
    detailPane.value?.pin(stepIndex, iterN);
  }
}

function onVideoClick(stepIndex) {
  if (isPinnedStep(stepIndex)) {
    pinnedKey.value = null;
    detailPane.value?.unpin();
  } else {
    pinnedKey.value = { stepIndex, iterN: null };
    detailPane.value?.pinStep(stepIndex);
  }
}

// Clear pin when session changes
watch(() => props.sessionId, () => {
  pinnedKey.value = null;
  detailPane.value?.unpin();
});

function onDetailUnpinned() {
  pinnedKey.value = null;
}

// Auto-pin to human-pending or accepted-pending iteration when not already pinned
watch(
  () => {
    for (const step of props.steps) {
      const it = step.iterations.find(it => it.humanPending || it.acceptedPending);
      if (it) return { stepIndex: step.index, iterN: it.n };
    }
    return null;
  },
  pending => {
    if (pending && !pinnedKey.value) {
      pinnedKey.value = pending;
      detailPane.value?.pin(pending.stepIndex, pending.iterN);
    }
  },
  { immediate: true }
);

// Clear stale pinnedKey when the pinned iteration no longer exists in steps
watch(
  () => props.steps,
  () => {
    if (!pinnedKey.value) return;
    const step = props.steps[pinnedKey.value.stepIndex];
    const iterExists = step?.iterations.some(it => it.n === pinnedKey.value.iterN);
    if (!iterExists) {
      pinnedKey.value = null;
      detailPane.value?.unpin();
    }
  },
  { deep: true }
);
</script>

<style scoped>
.step-label.type-video { border-left-color: #7c3aed; }

.video-progress-bar {
  height: 4px;
  background: var(--border, #333);
  border-radius: 2px;
  margin-top: 4px;
}
.video-progress-fill {
  height: 100%;
  background: #7c3aed;
  border-radius: 2px;
  transition: width 0.3s;
}

.step-actions {
  margin-left: auto;
  display: inline-flex;
  gap: 6px;
}
.step-action-btn {
  font-size: 10px;
  text-transform: none;
  letter-spacing: normal;
  padding: 1px 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: color .15s, border-color .15s;
}
.step-action-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.video-output {
  padding: 4px 0;
  cursor: pointer;
  border-radius: 4px;
  outline: 2px solid transparent;
  transition: outline-color 0.15s;
}
.video-output.selected {
  outline-color: var(--accent, #7c3aed);
}
.video-output:hover {
  outline-color: color-mix(in srgb, var(--accent, #7c3aed) 50%, transparent);
}
</style>

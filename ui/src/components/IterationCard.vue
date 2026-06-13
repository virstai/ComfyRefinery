<template>
  <div
    class="iter-thumb"
    :class="{
      'iter-thumb--running':          isRunning,
      'iter-thumb--accept':           iteration.verdict === 'ACCEPT' && !iteration.acceptedPending,
      'iter-thumb--reject':           iteration.verdict === 'REJECT',
      'iter-thumb--refused':          iteration.verdict === 'REFUSED',
      'iter-thumb--pending':          iteration.humanPending || iteration.acceptedPending,
      'iter-thumb--selected':         selected,
    }"
    @click="$emit('open')"
  >
    <div class="thumb-img">
      <img v-if="iteration.imageUrl" :src="iteration.imageUrl" :alt="`Iteration ${iteration.n}`">
      <div v-else class="thumb-placeholder">
        <span>{{ iteration.status || 'Waiting…' }}</span>
      </div>
      <div v-if="showProgress" class="thumb-progress">
        <div class="thumb-progress-fill" :style="{ width: iteration.progress + '%' }"></div>
      </div>
      <div v-if="iteration.humanPending"    class="thumb-badge">Review</div>
      <div v-if="iteration.acceptedPending" class="thumb-badge">Pending</div>
      <div v-if="iteration.poseImageUrl"    class="thumb-badge thumb-badge--pose" title="Pose guide used">Pose</div>
    </div>
    <div class="thumb-footer">
      <span class="thumb-num">#{{ iteration.n }}</span>
      <span v-if="iteration.verdict" class="verdict" :class="iteration.verdict.toLowerCase()">{{ iteration.verdict }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  iteration: { type: Object, required: true },
  selected:  { type: Boolean, default: false },
});
defineEmits(['open']);

const isRunning   = computed(() => !props.iteration.verdict && !!props.iteration.status);
const showProgress = computed(() => props.iteration.progress > 0 && props.iteration.progress < 100);
</script>

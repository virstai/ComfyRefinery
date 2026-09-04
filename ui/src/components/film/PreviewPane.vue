<template>
  <div class="preview">
    <!-- Media -->
    <div class="preview-media">
      <template v-if="liveHere">
        <img v-if="filmState.previewUrl" :src="filmState.previewUrl" class="preview-img" alt="">
        <div v-else class="preview-empty">{{ filmState.status || 'Working…' }}</div>
        <div class="preview-live">
          <div class="progress-bar"><div class="fill" :style="{ width: filmState.progress + '%' }"></div></div>
          <span class="hint">{{ filmState.status }}</span>
        </div>
      </template>
      <video
        v-else-if="preview.type === 'take' && preview.url"
        :key="preview.url"
        ref="player"
        :src="preview.url"
        class="preview-video"
        controls
        :loop="!playing"
        :autoplay="playing"
        @timeupdate="onTime"
        @loadedmetadata="onTime"
        @ended="onEnded"
      ></video>
      <img
        v-else-if="preview.type === 'image' && preview.url"
        :key="preview.url"
        :src="preview.url"
        class="preview-img zoomable"
        alt=""
        title="Click to enlarge"
        @click="openLightbox(preview.url, preview.caption)"
      >
      <div v-else class="preview-empty">
        <template v-if="segment">Nothing to show yet for segment {{ segment.index + 1 }} — run a take, or pick a start image in the inspector.</template>
        <template v-else>Add a segment to start.</template>
      </div>
    </div>

    <!-- Caption -->
    <div class="preview-caption">
      <span class="preview-caption-text">{{ liveHere ? `Segment ${segment.index + 1} · generating` : (preview.caption || '—') }}</span>
      <template v-if="playing">
        <button class="secondary small" :disabled="filmState.playlist.pos === 0" title="Previous clip" @click="timelineStep(-1)">⏮</button>
        <button class="secondary small" :disabled="filmState.playlist.pos >= filmState.playlist.items.length - 1" title="Next clip" @click="timelineStep(1)">⏭</button>
        <button class="danger small" @click="stopTimeline">■ Stop</button>
      </template>
      <button v-else-if="approvedCount" class="primary small" :disabled="liveHere" :title="`Play the ${approvedCount} approved take${approvedCount === 1 ? '' : 's'} back to back`" @click="playTimeline(segment?.status === 'approved' ? segment.id : null)">▶ Play timeline</button>
      <button v-if="preview.type === 'image' && preview.url && !liveHere" class="secondary small" @click="openLightbox(preview.url, preview.caption)">⛶ Enlarge</button>
      <a v-if="preview.url && !liveHere" :href="preview.url" target="_blank" rel="noopener" class="secondary small preview-open">Open</a>
    </div>

    <!-- Takes strip + verdict for the previewed take -->
    <div v-if="segment" class="preview-takes">
      <div class="preview-strip">
        <span class="hint preview-strip-label">Takes ({{ segment.takes?.length ?? 0 }})</span>
        <div v-if="!cards.length" class="hint">No takes yet.</div>
        <div v-else class="preview-strip-cards">
          <IterationCard
            v-for="c in cards"
            :key="c.takeId ?? 'running'"
            :iteration="c"
            :selected="c.takeId != null && c.takeId === preview.takeId"
            :is-output="c.takeId === segment.approvedTakeId"
            @open="c.takeId && previewTake(segment.takes.find(t => t.id === c.takeId), segment)"
          />
        </div>
      </div>
      <div v-if="take" class="preview-verdict">
        <textarea v-model="note" class="hr-feedback" rows="2" :disabled="busy" placeholder="Note: what worked, what to change — a rejection note steers the next take's prompt"></textarea>
        <div class="hr-actions">
          <button class="primary small" :disabled="busy || filmState.running || take.verdict === 'approved'" @click="verdict('approved')">✓ Approve</button>
          <button class="secondary small" :disabled="busy || filmState.running || take.verdict === 'rejected'" @click="verdict('rejected')">✗ Reject</button>
          <span class="sess-status" :class="{ approved: 'sess-complete', rejected: 'sess-error' }[take.verdict] ?? ''">{{ take.verdict ?? 'undecided' }}</span>
          <span v-if="take.id === segment.approvedTakeId" class="hint">feeds the next segment</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import IterationCard from '../IterationCard.vue';
import { filmState, takeToIteration, previewTake, setVerdict, playTimeline, stopTimeline, timelineEnded, timelineStep, timelineItemCount } from '../../stores/film.js';
import { openLightbox } from '../../stores/lightbox.js';

const props = defineProps({ segment: { type: Object, default: null } });

const preview  = computed(() => filmState.preview);
const player   = ref(null);
const note     = ref('');
const busy     = ref(false);

const liveHere = computed(() => filmState.running && props.segment && filmState.runSegmentId === props.segment.id);
const playing  = computed(() => !!filmState.playlist);
const approvedCount = computed(() => timelineItemCount());
const take     = computed(() => props.segment?.takes?.find(t => t.id === preview.value.takeId) ?? null);

const cards = computed(() => {
  const list = (props.segment?.takes ?? []).map((tk, i) => takeToIteration(tk, i + 1));
  if (liveHere.value) {
    list.push({ n: list.length + 1, takeId: null, videoUrl: null, imageUrl: filmState.previewUrl, verdict: null, status: filmState.status || 'Running…', progress: filmState.progress });
  }
  return list;
});

watch(take, tk => { note.value = tk?.note ?? ''; });

function onTime() { filmState.previewTime = player.value?.currentTime ?? 0; }
function onEnded() { if (playing.value) timelineEnded(); }

async function verdict(v) {
  if (!take.value) return;
  busy.value = true;
  try { await setVerdict(props.segment.id, take.value.id, v, note.value.trim()); }
  catch (err) { filmState.status = `Error: ${err.message}`; }
  finally { busy.value = false; }
}
</script>

<style scoped>
.preview { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.preview-media {
  flex: 1; min-height: 0; position: relative; background: #000; border-radius: var(--radius);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.preview-video, .preview-img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; }
.preview-img.zoomable { cursor: zoom-in; }
.preview-empty { color: var(--muted); font-size: 12px; padding: 20px; text-align: center; max-width: 420px; }
.preview-live { position: absolute; left: 12px; right: 12px; bottom: 10px; display: flex; flex-direction: column; gap: 4px; }
.preview-caption { display: flex; align-items: center; gap: 8px; padding: 6px 2px; font-size: 12px; color: var(--muted); flex-shrink: 0; }
.preview-caption-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-open { text-decoration: none; }
.preview-takes { flex-shrink: 0; display: flex; gap: 14px; align-items: flex-start; padding-top: 4px; border-top: 1px solid var(--border); }
.preview-strip { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.preview-strip-label { white-space: nowrap; }
.preview-strip-cards { display: flex; gap: 8px; overflow-x: auto; padding: 4px 2px; }
.preview-strip-cards :deep(.iter-thumb) { width: 110px; flex-shrink: 0; }
.preview-verdict { width: 340px; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
.preview-verdict .hr-feedback { width: 100%; }
.preview-verdict .hr-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>

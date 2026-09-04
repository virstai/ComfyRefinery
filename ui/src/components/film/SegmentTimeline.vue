<template>
  <div class="timeline">
    <div
      v-for="s in segments"
      :key="s.id"
      class="seg-card"
      :class="{ selected: s.id === selectedId, [`seg-${s.status}`]: true, running: s.id === runningId }"
      :title="statusTitle(s)"
      @click="$emit('select', s.id)"
    >
      <div class="seg-thumb">
        <img v-if="lastFrame(s)" :src="lastFrame(s)" alt="" title="Double-click to enlarge" @dblclick.stop="openLightbox(lastFrame(s), `Segment ${s.index + 1} — last frame of the approved take`)">
        <video v-else-if="approvedVideo(s)" :src="approvedVideo(s)" muted></video>
        <div v-else class="seg-thumb-empty">{{ s.takes?.length ? `${s.takes.length} take${s.takes.length === 1 ? '' : 's'}` : 'no takes' }}</div>
      </div>
      <div class="seg-footer">
        <span class="seg-num">#{{ s.index + 1 }}</span>
        <span class="sess-status" :class="badgeClass(s)">{{ s.id === runningId ? 'running' : s.status }}</span>
      </div>
    </div>
    <div v-if="canAdd" class="seg-card seg-add" title="Add a segment" @click="$emit('add')">+</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { mediaUrl } from '../../stores/film.js';
import { openLightbox } from '../../stores/lightbox.js';

const props = defineProps({
  segments:   { type: Array, default: () => [] },
  selectedId: { type: String, default: null },
  runningId:  { type: String, default: null },
});
defineEmits(['select', 'add']);

const canAdd = computed(() => {
  const last = props.segments[props.segments.length - 1];
  return !last || last.status === 'approved';
});

function approvedTake(s) { return s.takes?.find(t => t.id === s.approvedTakeId) ?? null; }
function lastFrame(s) { const t = approvedTake(s); return t?.lastFrame ? mediaUrl(t.lastFrame) : null; }
function approvedVideo(s) { const t = approvedTake(s); return t ? (t.videoUrl ?? mediaUrl(t.localFile)) : null; }

function badgeClass(s) {
  if (s.id === props.runningId) return 'sess-running';
  return { approved: 'sess-complete', stale: 'seg-stale-badge', running: 'sess-running' }[s.status] ?? '';
}
function statusTitle(s) {
  if (s.status === 'stale') return 'The start frame changed since this segment was made — re-run it';
  return `Segment ${s.index + 1} · ${s.status}`;
}
</script>

<style scoped>
.timeline { display: flex; gap: 8px; overflow-x: auto; overflow-y: hidden; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); flex-shrink: 0; height: 132px; box-sizing: border-box; align-items: stretch; }
.seg-card {
  width: 148px; flex-shrink: 0; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); cursor: pointer; overflow: hidden; display: flex; flex-direction: column;
}
.seg-card:hover { border-color: var(--accent); }
.seg-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.seg-card.seg-approved { border-color: color-mix(in srgb, var(--accept) 60%, var(--border)); }
.seg-card.seg-stale { border-color: color-mix(in srgb, var(--warning, #d97706) 70%, var(--border)); }
.seg-card.running { border-color: var(--accent); }
.seg-thumb { flex: 1; min-height: 0; background: #000; display: flex; align-items: center; justify-content: center; }
.seg-thumb img, .seg-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.seg-thumb-empty { font-size: 11px; color: var(--muted); }
.seg-footer { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; }
.seg-num { font-size: 12px; font-weight: 600; color: var(--muted); }
.seg-stale-badge { background: color-mix(in srgb, var(--warning, #d97706) 20%, transparent); color: var(--warning, #d97706); }
.seg-add { align-items: center; justify-content: center; font-size: 22px; color: var(--muted); }
</style>

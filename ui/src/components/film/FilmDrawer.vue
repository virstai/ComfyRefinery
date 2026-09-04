<template>
  <div class="drawer-overlay" @click="$emit('close')">
    <div class="drawer" :style="{ width }" @click.stop>
      <div class="drawer-head">
        <span class="drawer-title">{{ title }}</span>
        <slot name="head"></slot>
        <button class="secondary small" style="margin-left:auto" @click="$emit('close')">Close</button>
      </div>
      <div class="drawer-body"><slot></slot></div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
defineProps({ title: { type: String, default: '' }, width: { type: String, default: '460px' } });
const emit = defineEmits(['close']);
function onKey(e) { if (e.key === 'Escape') emit('close'); }
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.drawer-overlay { position: absolute; inset: 0; z-index: 50; background: rgba(0,0,0,.45); display: flex; justify-content: flex-end; }
.drawer {
  height: 100%; max-width: 92vw; background: var(--surface); border-left: 1px solid var(--border);
  display: flex; flex-direction: column; box-shadow: -8px 0 30px rgba(0,0,0,.4);
}
.drawer-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--surface2); flex-shrink: 0; }
.drawer-title { font-size: 13px; font-weight: 600; }
.drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px 24px; display: flex; flex-direction: column; }
</style>

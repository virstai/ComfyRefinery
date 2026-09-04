<template>
  <div v-if="lightboxState.url" class="lightbox" @click="closeLightbox">
    <img :src="lightboxState.url" :alt="lightboxState.caption" class="lightbox-img" @click.stop>
    <div class="lightbox-bar" @click.stop>
      <span class="lightbox-caption">{{ lightboxState.caption }}</span>
      <a :href="lightboxState.url" target="_blank" rel="noopener" class="secondary small lightbox-open">Open in new tab</a>
      <button class="secondary small" @click="closeLightbox">Close (Esc)</button>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { lightboxState, closeLightbox } from '../stores/lightbox.js';

function onKey(e) { if (e.key === 'Escape' && lightboxState.url) closeLightbox(); }
onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.lightbox {
  position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,.88);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px;
  cursor: zoom-out;
}
.lightbox-img { max-width: 100%; max-height: calc(100vh - 90px); object-fit: contain; border-radius: 4px; cursor: default; box-shadow: 0 8px 40px rgba(0,0,0,.6); }
.lightbox-bar { display: flex; align-items: center; gap: 10px; cursor: default; max-width: 100%; }
.lightbox-caption { font-size: 12px; color: #ddd; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lightbox-open { text-decoration: none; }
</style>

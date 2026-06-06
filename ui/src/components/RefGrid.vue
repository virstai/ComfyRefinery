<template>
  <div
    class="ref-grid-wrap"
    :class="{ 'ref-grid-drag': dragging }"
    @dragover.prevent="$emit('dragover')"
    @dragleave.self="$emit('dragleave')"
    @drop.prevent="$emit('drop', $event)"
  >
    <!-- Empty state -->
    <div v-if="!refs.length" class="ref-grid-empty" @click="$emit('add-click')">
      <span class="ref-grid-hint">
        {{ uploading ? 'Uploading…' : 'Drop reference images here · click to browse' }}
      </span>
    </div>

    <!-- Populated grid -->
    <div v-else class="ref-grid">
      <RefImage
        v-for="(ref, i) in refs"
        :key="ref.filename + i"
        :src="refUrl(ref)"
        :index="i"
        @remove="$emit('remove', i)"
      />
      <!-- Add-more tile -->
      <div
        class="ref-add-tile"
        :class="{ 'is-uploading': uploading }"
        :title="uploading ? 'Uploading…' : 'Add more references'"
        @click.stop="!uploading && $emit('add-click')"
      >
        <span v-if="uploading" class="ref-spinner">…</span>
        <span v-else>+</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import RefImage from './RefImage.vue';

const props = defineProps({
  refs:      { type: Array,   default: () => [] },
  uploading: { type: Boolean, default: false },
  dragging:  { type: Boolean, default: false },
});

defineEmits(['add-click', 'remove', 'drop', 'dragover', 'dragleave']);

function refUrl(ref) {
  return `/api/image?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder ?? '')}&type=${encodeURIComponent(ref.type ?? 'input')}`;
}
</script>

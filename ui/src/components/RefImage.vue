<template>
  <div class="ref-img" :title="`Reference ${index + 1}`">
    <img :src="src" :alt="`ref ${index + 1}`" draggable="false">
    <button class="ref-img-remove" @click.stop="$emit('remove')" title="Remove">×</button>
    <span class="ref-img-num">{{ index + 1 }}</span>
  </div>
</template>

<script setup>
defineProps({
  src:   { type: String, required: true },
  index: { type: Number, required: true },
});
defineEmits(['remove']);
</script>

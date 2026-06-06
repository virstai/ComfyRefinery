<template>
  <div class="wf-select" :class="{ 'wf-select--open': open }" ref="root">
    <button class="wf-select-trigger" @click="toggle" :title="activeLabel">
      <span class="wf-select-value">{{ activeLabel }}</span>
      <span class="wf-select-chevron">▾</span>
    </button>

    <div v-if="open" class="wf-select-menu">
      <button
        v-for="(wf, id) in workflows"
        :key="id"
        class="wf-select-option"
        :class="{ 'is-active': id === modelValue }"
        @click="select(id)"
      >
        <span class="wf-select-option-label">{{ wf.label || id }}</span>
        <span class="wf-select-option-meta">{{ wf.steps?.length ?? 0 }} step{{ wf.steps?.length !== 1 ? 's' : '' }}</span>
      </button>
      <div v-if="!Object.keys(workflows).length" class="wf-select-empty">No workflows configured</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  modelValue: { type: String,  default: null },
  workflows:  { type: Object,  default: () => ({}) },
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const root = ref(null);

const activeLabel = computed(() => {
  if (props.modelValue && props.workflows[props.modelValue]) {
    return props.workflows[props.modelValue].label || props.modelValue;
  }
  return '— select workflow —';
});

function toggle() { open.value = !open.value; }

function select(id) {
  emit('update:modelValue', id);
  open.value = false;
}

function onOutsideClick(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false;
}

onMounted(()       => document.addEventListener('mousedown', onOutsideClick));
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutsideClick));
</script>

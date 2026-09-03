<template>
  <div class="ref-form">
    <label style="margin:0;flex:0 0 120px">Kind
      <select :value="modelValue.kind" @change="update('kind', $event.target.value)">
        <option v-for="k in KINDS" :key="k" :value="k">{{ k }}</option>
      </select>
    </label>
    <label style="margin:0;flex:1">Name<input :value="modelValue.name" :placeholder="modelValue.kind === 'scene' ? 'e.g. Diner exterior, night' : 'e.g. Mira'" @input="update('name', $event.target.value)"></label>
    <label style="margin:0;flex:2">Description<input :value="modelValue.description" placeholder="what the prompt writer should repeat: red scarf, short black hair…" @input="update('description', $event.target.value)"></label>
  </div>
</template>

<script setup>
const KINDS = ['character', 'location', 'prop', 'style', 'voice', 'scene'];
const props = defineProps({ modelValue: { type: Object, required: true } });
const emit  = defineEmits(['update:modelValue']);
function update(key, value) { emit('update:modelValue', { ...props.modelValue, [key]: value }); }
</script>

<style scoped>
.ref-form { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0; }
.ref-form label { font-size: 11px; }
.ref-form input, .ref-form select { width: 100%; }
</style>

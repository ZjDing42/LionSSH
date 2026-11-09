<script setup lang="ts">
import { computed } from 'vue';
import { fileIcon } from '../file-icons';

const props = withDefaults(defineProps<{ name: string; directory?: boolean; expanded?: boolean; size?: number }>(), { size: 16 });
const source = computed(() => {
  const icon = fileIcon(props.name, props.directory, props.expanded);
  return new URL(`../assets/file-icons/${icon}.svg`, import.meta.url).href;
});
</script>

<template>
  <img class="file-icon" :src="source" :width="size" :height="size" alt="" aria-hidden="true" draggable="false" />
</template>

<style scoped>
.file-icon { display:block; flex-shrink:0; object-fit:contain; pointer-events:none; user-select:none; }
</style>

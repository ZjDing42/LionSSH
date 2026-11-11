<script setup lang="ts">
import { onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { t } from '../i18n';

const props = defineProps<{ users: string[] }>();
const owner = ref<HTMLElement>();
const shown = ref(false);
const id = useId();
let timer: ReturnType<typeof setTimeout> | undefined;
function hide() { clearTimeout(timer); shown.value = false; }
function show() { clearTimeout(timer); shown.value = props.users.length > 1; }
function leave() {
  if (!owner.value?.contains(document.activeElement)) timer = setTimeout(hide, 180);
}
function focusOut(event: FocusEvent) { if (!owner.value?.contains(event.relatedTarget as Node | null)) hide(); }
function outside(event: PointerEvent) { if (!owner.value?.contains(event.target as Node)) hide(); }
watch(() => props.users.length, length => { if (length < 2) hide(); });
onMounted(() => document.addEventListener('pointerdown', outside));
onUnmounted(() => { clearTimeout(timer); document.removeEventListener('pointerdown', outside); });
</script>

<template>
  <div v-if="users.length" ref="owner" class="gpu-user-wrap" :class="{ 'single-user': users.length === 1, 'users-open': shown }" @mouseenter="show" @mouseleave="leave" @focusin="show" @focusout="focusOut" @keydown.esc.stop.prevent="hide">
    <button v-if="users.length > 1" class="gpu-user-badge" type="button" :aria-label="t('查看其他 GPU 用户')" :aria-expanded="shown" :aria-controls="id" @click.stop="show">
      <span class="gpu-user-name">{{ users[0] }}</span><span class="gpu-user-count">+{{ users.length - 1 }}</span>
    </button>
    <span v-else class="gpu-user-badge"><span class="gpu-user-name">{{ users[0] }}</span></span>
    <div v-if="shown && users.length > 1" :id="id" class="gpu-user-popover">
      <p>{{ t('其他用户') }}</p><ul><li v-for="user in users.slice(1)" :key="user">{{ user }}</li></ul>
    </div>
  </div>
</template>

<style scoped>
.gpu-user-wrap { position: relative; z-index: 2; display: flex; margin-left: auto; min-width: 0; max-width: 48%; }
.gpu-user-wrap.single-user { pointer-events: none; }
.gpu-user-wrap.users-open { z-index: 4; }
.gpu-user-badge { padding: 0; font: inherit; text-align: left; }
.gpu-user-popover { position: absolute; top: calc(100% + 9px); right: 0; width: 180px; padding: 5px; border: 1px solid var(--surface-border); border-radius: 9px; color: var(--text); background: var(--slurm-sticky-surface); box-shadow: 0 8px 24px #101c3430; cursor: default; animation: gpu-users-enter .11s ease-out; }
.gpu-user-popover::before { content: ''; position: absolute; top: -5px; right: 24px; width: 7px; height: 7px; transform: rotate(45deg); border-top: 1px solid var(--surface-border); border-left: 1px solid var(--surface-border); background: var(--slurm-sticky-surface); }
.gpu-user-popover::after { content: ''; position: absolute; top: -12px; left: 0; right: 0; height: 12px; }
.gpu-user-popover p { padding: 5px 9px 7px; color: var(--text-subtle); font-size: 11px; border-bottom: 1px solid var(--line); }
.gpu-user-popover ul { list-style: none; padding: 3px 0 0; margin: 0; max-height: 220px; overflow: auto; overscroll-behavior: contain; }
.gpu-user-popover li { padding: 6px 9px; font-size: 12px; overflow-wrap: anywhere; }
@keyframes gpu-users-enter { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .gpu-user-popover { animation: none; } }
</style>

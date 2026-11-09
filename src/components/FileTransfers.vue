<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { t } from '../i18n';
import type { LionApi, Profile } from '../types';
import type { FileTransfer } from '../file-types';
const props = defineProps<{ tasks: FileTransfer[]; profiles: Profile[]; api: LionApi | undefined }>();
const emit = defineEmits<{ error: [value: string] }>();
const visible = ref(false), all = ref(false);
const context = ref<{ x: number; y: number; ready: boolean; task: FileTransfer } | null>(null);
const contextMenu = ref<HTMLElement>();
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let metricsTimer: ReturnType<typeof setInterval> | undefined;
const metrics = ref<Record<string, { speed: number; remaining: number | null }>>({});
const emptyMetrics = { speed: 0, remaining: null };
function displayedMetrics(task: FileTransfer) { return task.status === 'running' ? metrics.value[task.id] || emptyMetrics : emptyMetrics; }
function refreshMetrics() {
  metrics.value = Object.fromEntries(props.tasks.filter(task => task.status === 'running').map(task => [task.id, { speed: task.speed, remaining: task.remaining }]));
}
const terminal = (task: FileTransfer) => ['completed', 'cancelled'].includes(task.status);
const labels: Record<FileTransfer['status'], string> = { queued: '排队中', scanning: '正在统计', running: '传输中', paused: '已暂停', waiting: '等待重新连接', conflict: '同名文件：右键选择处理方式', failed: '传输失败', completed: '已完成', cancelled: '已取消' };
const activeCount = computed(() => props.tasks.filter(t => !terminal(t)).length);
const totalSpeed = computed(() => props.tasks.reduce((sum, task) => sum + displayedMetrics(task).speed, 0));
function size(value: number | null) {
  if (value === null) return '—'; const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
}
function seconds(value: number | null) { if (value === null || !Number.isFinite(value)) return '—'; return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
function progress(task: FileTransfer) { return task.status === 'completed' ? 100 : task.total ? Math.min(100, (task.transferred + (task.skipped || 0)) / task.total * 100) : 0; }
function location(profileId: string | null, path: string) {
  if (profileId) return `${props.profiles.find(p => p.id === profileId)?.name || profileId}: ${path}`;
  return path.startsWith('\\\\?\\UNC\\') ? `\\\\${path.slice(8)}` : path.startsWith('\\\\?\\') ? path.slice(4) : path;
}
function targetLocation(task: FileTransfer) { return task.nativeDrop ? t('拖放目标文件夹') : location(task.target.profileId, task.target.path); }
async function control(task: FileTransfer, action: string, decision?: string) {
  context.value = null;
  try { await props.api?.fileRequest?.('control', { id: task.id, action, decision, all: all.value }); }
  catch (error) { emit('error', String(error instanceof Error ? error.message : error)); }
}
async function openContext(event: MouseEvent | KeyboardEvent, task: FileTransfer) {
  event.preventDefault(); event.stopPropagation(); all.value = false;
  const row = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const x = event instanceof MouseEvent ? event.clientX : row.left;
  const y = event instanceof MouseEvent ? event.clientY : row.bottom;
  context.value = { x, y, ready: false, task };
  const opened = context.value;
  await nextTick();
  if (context.value !== opened || !contextMenu.value) return;
  const { width, height } = contextMenu.value.getBoundingClientRect();
  const place = (anchor: number, size: number, viewport: number) =>
    Math.max(8, Math.min(anchor + size <= viewport - 8 ? anchor : anchor - size, viewport - size - 8));
  opened.x = place(x, width, innerWidth);
  opened.y = place(y, height, innerHeight);
  opened.ready = true;
}
watch(() => props.tasks.map(t => `${t.id}:${t.status}`).join('|'), () => {
  clearTimeout(closeTimer);
  // Sample the rate fields once a second; byte/progress updates remain independent.
  const running = new Set(props.tasks.filter(task => task.status === 'running').map(task => task.id));
  if (running.size) {
    if (!metricsTimer) { refreshMetrics(); metricsTimer = setInterval(refreshMetrics, 1000); }
    for (const id of Object.keys(metrics.value)) if (!running.has(id)) delete metrics.value[id];
  } else { clearInterval(metricsTimer); metricsTimer = undefined; metrics.value = {}; }
  if (!props.tasks.length) { visible.value = false; return; }
  visible.value = true;
  if (props.tasks.every(terminal)) closeTimer = setTimeout(() => {
    visible.value = false; context.value = null;
    for (const task of props.tasks.filter(terminal)) void control(task, 'dismiss');
  }, 3000);
}, { immediate: true });
onBeforeUnmount(() => { clearTimeout(closeTimer); clearInterval(metricsTimer); });
</script>
<template>
  <section v-if="visible" class="file-transfers" data-testid="file-transfers" :aria-label="t('文件传输')">
    <header><span><Icon name="exchange" :size="15" />{{ t('文件传输') }} <small>{{ activeCount }}</small></span><span>{{ size(totalSpeed) }}/s</span></header>
    <div class="file-transfers-scroll"><table><thead><tr><th>{{ t('名称') }}</th><th>{{ t('状态') }}</th><th>{{ t('进度') }}</th><th>{{ t('已传 / 大小') }}</th><th>{{ t('来源路径') }}</th><th>↔</th><th>{{ t('目标路径') }}</th><th>{{ t('速度') }}</th><th>{{ t('已耗时') }}</th><th>{{ t('预计剩余') }}</th></tr></thead>
      <tbody><tr v-for="task in tasks" :key="task.id" :class="{ failed: task.status === 'failed', conflict: task.status === 'conflict' }" tabindex="0" :data-transfer-id="task.id" :title="task.error || task.currentPath" @contextmenu="openContext($event, task)" @keydown.shift.f10.prevent="openContext($event, task)">
        <td class="transfer-name">{{ task.name }}</td><td>{{ t(labels[task.status]) }}</td><td><div class="transfer-meter"><span :style="{ width: `${progress(task)}%` }" /></div><small>{{ progress(task).toFixed(1) }}%</small></td><td>{{ size(task.transferred) }} / {{ size(task.total) }}</td><td class="transfer-path" :title="location(task.source.profileId, task.source.path)">{{ location(task.source.profileId, task.source.path) }}</td><td><Icon :name="task.direction === 'upload' ? 'upload' : task.direction === 'download' ? 'download' : 'copy'" :size="14" /></td><td class="transfer-path" :title="targetLocation(task)">{{ targetLocation(task) }}</td><td>{{ size(displayedMetrics(task).speed) }}/s</td><td>{{ seconds(task.elapsed) }}</td><td>{{ seconds(displayedMetrics(task).remaining) }}</td>
      </tr></tbody></table></div>
    <Teleport to="body"><div v-if="context" class="transfer-menu-backdrop" @pointerdown.self="context = null" @contextmenu.prevent="context = null"><div ref="contextMenu" class="files-context" role="menu" :style="{ left: `${context.x}px`, top: `${context.y}px`, visibility: context.ready ? 'visible' : 'hidden' }">
      <template v-if="context.task.status === 'conflict'"><button role="menuitem" @click="control(context.task, 'resolve', 'overwrite')">{{ t('覆盖') }}</button><button role="menuitem" @click="control(context.task, 'resolve', 'skip')">{{ t('跳过') }}</button><button role="menuitem" @click="control(context.task, 'resolve', 'keep')">{{ t('保留两份') }}</button><button role="menuitemcheckbox" :aria-checked="all" @click="all = !all"><span>{{ all ? '✓' : '○' }}</span>{{ t('应用到本批次') }}</button><hr /></template>
      <button v-if="['running', 'queued', 'scanning', 'waiting'].includes(context.task.status)" role="menuitem" @click="control(context.task, 'pause')">{{ t('暂停') }}</button>
      <button v-if="context.task.status === 'paused'" role="menuitem" @click="control(context.task, 'resume')">{{ t('继续') }}</button>
      <button v-if="context.task.status === 'failed'" role="menuitem" @click="control(context.task, 'retry')">{{ t('失败重试') }}</button>
      <button v-if="!terminal(context.task)" role="menuitem" @click="control(context.task, 'cancel')">{{ t('取消传输') }}</button>
      <button v-if="terminal(context.task)" role="menuitem" @click="control(context.task, 'dismiss')">{{ t('清除记录') }}</button>
      <p v-if="context.task.error" class="transfer-menu-error">{{ context.task.error }}</p>
    </div></div></Teleport>
  </section>
</template>
<style>
.file-transfers { grid-column:1/-1; border-top:1px solid var(--surface-border); min-width:0; background:var(--surface); }.file-transfers>header { display:flex; align-items:center; justify-content:space-between; padding:9px 14px; font-size:11px; color:var(--muted); background:var(--surface-soft); }.file-transfers>header>span:first-child { display:flex; align-items:center; gap:8px; font-weight:600; color:var(--text); }.file-transfers header small { background:var(--progress-track); padding:1px 5px; border-radius:3px; font-weight:400; }.file-transfers-scroll { max-height:190px; overflow:auto; }.file-transfers table { width:100%; border-collapse:collapse; font-size:10px; white-space:nowrap; }.file-transfers th { position:sticky; top:0; background:var(--surface-soft); z-index:1; color:var(--muted); font-weight:400; text-align:left; padding:7px 10px; }.file-transfers td { padding:9px 10px; border-top:1px solid var(--line); color:var(--text-secondary); }.file-transfers td.transfer-name { color:var(--text); max-width:180px; overflow:hidden; text-overflow:ellipsis; }.transfer-path { max-width:180px; overflow:hidden; text-overflow:ellipsis; }.file-transfers tr:hover td { background:var(--accent-soft); }.file-transfers .failed td:nth-child(2) { color:var(--red); }.file-transfers .conflict td:nth-child(2) { color:var(--amber); }.transfer-meter { display:inline-block; vertical-align:middle; width:65px; height:4px; border-radius:9px; background:var(--progress-track); overflow:hidden; margin-right:7px; }.transfer-meter>span { display:block; background:var(--green); height:100%; transition:width .15s; }.transfer-menu-backdrop { position:fixed; inset:0; z-index:1499; }.transfer-menu-error { white-space:normal; overflow-wrap:anywhere; padding:5px 10px; font-size:11px; color:var(--red); max-height:80px; overflow:auto; }
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import Icon from './Icon.vue';
import { message, t } from '../i18n';
import { processElapsed } from '../gpu-process';
import { createGpuPanelMotion } from '../gpu-motion';
import type { GpuCloseMotion } from '../gpu-motion';
import type { GpuCard, GpuProcess, GpuProcessStopPreview, LionApi, Profile, ServerState } from '../types';

const props = defineProps<{ card: GpuCard; profile: Profile; state: ServerState; api?: LionApi; origin: HTMLElement }>();
const emit = defineEmits<{ close: [] }>();
const overlay = ref<HTMLElement>();
const backdrop = ref<HTMLElement>();
const panel = ref<HTMLElement>();
const confirmation = ref<HTMLElement>();
const preview = ref<GpuProcessStopPreview | null>(null);
const refreshing = ref(false);
const preparing = ref<number | null>(null);
const stopping = ref(false);
const closing = ref(false);
const opening = ref(true);
const closeRoute = ref<GpuCloseMotion>('blur');
const error = ref('');
const notice = ref('');
const now = ref(Date.now());
const layout = ref({ left: '0px', right: '0px', '--panel-left': '44px', '--panel-right': '44px' });
const processes = computed(() => [...(props.card.processes || [])].sort((a, b) => b.pid - a.pid));
const connected = computed(() => props.state.status === 'connected');
const sampling = computed(() => refreshing.value || ['loading', 'polling'].includes(props.state.gpu.status));
const expired = computed(() => Boolean(preview.value && now.value >= preview.value.expiresAt));
let disposed = false;
let timer: ReturnType<typeof setInterval>;
let motion: ReturnType<typeof createGpuPanelMotion> | undefined;
let observer: ResizeObserver | undefined;
let previousOverflow = '';
let previousPaddingRight = '';
let closeRequested: GpuCloseMotion | null = null;
let request = 0;

function updateLayout() {
  const workspace = props.origin.closest('.workspace');
  if (!workspace) return;
  const rect = workspace.getBoundingClientRect();
  const css = getComputedStyle(workspace);
  layout.value = { left: `${rect.left}px`, right: `${Math.max(0, innerWidth - rect.right)}px`,
    '--panel-left': css.paddingLeft, '--panel-right': css.paddingRight };
}
async function close(route: GpuCloseMotion = 'blur') {
  if (stopping.value || closing.value) return;
  if (opening.value) { closeRequested = route; return; }
  closing.value = true;
  closeRoute.value = route;
  request++;
  preview.value = null;
  try { await motion?.close(route); }
  catch { /* A visual effect must never prevent closing the live panel. */ }
  if (disposed) return;
  emit('close');
  await nextTick();
  if (props.origin.isConnected) props.origin.querySelector<HTMLButtonElement>('.gpu-detail-open')?.focus({ preventScroll: true });
}
async function refresh() {
  if (!props.api || !connected.value || sampling.value) return;
  refreshing.value = true;
  error.value = '';
  try { await props.api.refreshGpu(props.profile.id); }
  catch (reason) { if (!disposed) error.value = String(reason); }
  finally { refreshing.value = false; }
}
async function prepare(process: GpuProcess) {
  if (!props.api || !process.canStop || !connected.value || preparing.value !== null || stopping.value) return;
  const current = ++request;
  preparing.value = process.pid;
  error.value = ''; notice.value = '';
  try {
    const value = await props.api.prepareGpuProcessStop(props.profile.id, props.card.uuid, process.pid);
    if (disposed || closing.value || current !== request || !connected.value) return;
    preview.value = value;
    await nextTick();
    confirmation.value?.querySelector<HTMLButtonElement>('button')?.focus();
  } catch (reason) { if (!disposed && current === request) error.value = String(reason); }
  finally { preparing.value = null; }
}
function dismissConfirmation() {
  if (stopping.value) return;
  preview.value = null;
  panel.value?.focus({ preventScroll: true });
}
async function stop(mode: 'terminate' | 'kill') {
  const value = preview.value;
  if (!value || expired.value || !props.api || !connected.value || stopping.value) return;
  stopping.value = true;
  try {
    await props.api.stopGpuProcess(props.profile.id, value.token, mode);
    if (!disposed) notice.value = '已发送结束信号；进程列表将随检测更新。';
  } catch (reason) { if (!disposed) error.value = String(reason); }
  finally { stopping.value = false; dismissConfirmation(); }
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (preview.value) dismissConfirmation(); else void close();
  }
  if (event.key === 'Tab') {
    const container = preview.value ? confirmation.value : panel.value;
    const buttons = [...(container?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') || [])];
    const first = buttons[0], last = buttons.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (!container?.contains(document.activeElement) || (event.shiftKey && (document.activeElement === first || document.activeElement === container))) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
}
onMounted(async () => {
  const widthBeforeLock = document.body.getBoundingClientRect().width;
  const paddingBeforeLock = parseFloat(getComputedStyle(document.body).paddingRight) || 0;
  previousOverflow = document.body.style.overflow;
  previousPaddingRight = document.body.style.paddingRight;
  document.body.style.overflow = 'hidden';
  // Older WebViews may ignore scrollbar-gutter. Compensate only if width changed.
  const releasedWidth = document.body.getBoundingClientRect().width - widthBeforeLock;
  if (releasedWidth > 0) document.body.style.paddingRight = `${paddingBeforeLock + releasedWidth}px`;
  updateLayout();
  const workspace = props.origin.closest('.workspace');
  observer = new ResizeObserver(updateLayout);
  if (workspace) observer.observe(workspace);
  window.addEventListener('resize', updateLayout);
  document.addEventListener('keydown', keydown, true);
  timer = setInterval(() => { now.value = Date.now(); }, 1000);
  await nextTick();
  if (disposed) return;
  if (!overlay.value || !panel.value || !backdrop.value) return;
  motion = createGpuPanelMotion(overlay.value, panel.value, backdrop.value, props.origin);
  try { await motion.open(); }
  catch { panel.value.style.visibility = 'visible'; backdrop.value.style.opacity = '1'; }
  if (disposed) return;
  opening.value = false;
  await nextTick();
  if (disposed) return;
  if (closeRequested) void close(closeRequested);
  else panel.value?.focus({ preventScroll: true });
});
onUnmounted(() => {
  disposed = true;
  request++;
  clearInterval(timer);
  motion?.dispose();
  observer?.disconnect();
  document.body.style.overflow = previousOverflow;
  document.body.style.paddingRight = previousPaddingRight;
  window.removeEventListener('resize', updateLayout);
  document.removeEventListener('keydown', keydown, true);
});
</script>

<template>
  <Teleport to="body">
    <div ref="overlay" class="gpu-process-overlay" :class="{ closing }" :data-motion="closing ? closeRoute : opening ? 'opening' : 'open'" :style="layout" @click.self="close('particles')">
      <div ref="backdrop" class="gpu-process-backdrop" aria-hidden="true" @click="close('particles')" />
      <section ref="panel" class="gpu-process-panel" role="dialog" aria-modal="true" aria-labelledby="gpu-process-title" tabindex="-1" :inert="Boolean(preview) || closing || opening">
        <div class="gpu-process-content">
        <header class="gpu-process-header">
          <div><h2 id="gpu-process-title">{{ t('GPU {index} · 进程', { index: card.index }) }}</h2><p>{{ card.name }} · {{ profile.name }}</p></div>
          <div class="gpu-process-actions"><button class="icon-button" :title="t('刷新进程列表')" :aria-label="t('刷新进程列表')" :disabled="!connected || sampling || stopping" @click="refresh()"><Icon name="refresh" :size="18" :class="{ spinning: sampling }" /></button><button class="icon-button" :title="t('关闭')" :aria-label="t('关闭')" :disabled="stopping" @click="close()"><Icon name="close" :size="20" /></button></div>
        </header>
        <p v-if="error || state.gpu.processError || state.gpu.error || !connected" class="gpu-process-message error" role="alert">{{ message(error || state.gpu.processError || state.gpu.error || 'SSH 连接已断开') }}</p>
        <p v-else-if="notice" class="gpu-process-message" role="status">{{ t(notice) }}</p>
        <div class="gpu-process-table-wrap" tabindex="0" :aria-label="t('GPU 进程列表')">
          <table class="gpu-process-table"><thead><tr><th>PID</th><th>{{ t('进程名') }}</th><th>{{ t('用户') }}</th><th>{{ t('运行时长') }}</th><th>{{ t('显存占用') }}</th><th>{{ t('类型') }}</th><th>{{ t('操作') }}</th></tr></thead>
            <tbody><tr v-for="process in processes" :key="`${process.pid}:${process.startTicks || ''}`"><td>{{ process.pid }}</td><td class="gpu-process-name" :title="process.name">{{ process.name }}</td><td :title="process.username">{{ process.username || t('未知') }}</td><td>{{ processElapsed(process.elapsedSeconds) }}</td><td>{{ process.memoryUsedMiB == null ? '—' : `${process.memoryUsedMiB.toLocaleString()} MiB` }}</td><td>{{ process.type || 'C' }}</td><td><button v-if="process.canStop" class="icon-button gpu-stop-button" :title="t('结束进程')" :aria-label="t('结束进程 {pid}', { pid: process.pid })" :disabled="!connected || preparing !== null || stopping || Boolean(state.gpu.error)" @click="prepare(process)"><Icon :name="preparing === process.pid ? 'refresh' : 'trash'" :class="{ spinning: preparing === process.pid }" :size="16" /></button></td></tr>
              <tr v-if="!processes.length"><td colspan="7" class="gpu-process-empty">{{ sampling ? t('正在读取进程…') : t('当前 GPU 没有进程') }}</td></tr>
            </tbody>
          </table>
        </div>
        <footer class="gpu-process-footer"><span>{{ t('{count} 个进程', { count: processes.length }) }}</span><span>{{ profile.gpu.enabled ? t('跟随 GPU 检测，每 {seconds} 秒刷新', { seconds: profile.gpu.intervalSec }) : t('自动检测已暂停，可手动刷新') }}</span></footer>
        </div>
      </section>
      <div v-if="preview" class="gpu-stop-backdrop" @click.self="dismissConfirmation()">
        <section ref="confirmation" class="modal gpu-stop-confirm" role="alertdialog" aria-modal="true" aria-labelledby="gpu-stop-title">
          <h2 id="gpu-stop-title">{{ t('结束此进程？') }}</h2>
          <dl class="confirmation-details"><div><dt>PID</dt><dd>{{ preview.pid }}</dd></div><div><dt>{{ t('进程名') }}</dt><dd>{{ preview.name }}</dd></div><div><dt>{{ t('所属用户') }}</dt><dd>{{ preview.username }}</dd></div></dl>
          <p class="gpu-stop-warning">{{ t('如果当前作业由slurm提交 删除进程不会主动结束作业') }}</p>
          <p>{{ t('正常结束允许进程自行清理；强制结束会立即停止进程。仅操作当前 PID。') }}</p>
          <p v-if="expired" role="status">{{ t('结束进程确认已过期，请重新确认') }}</p>
          <div class="modal-actions"><button class="button secondary" :disabled="stopping" @click="dismissConfirmation()">{{ t('取消') }}</button><button class="button primary" :disabled="stopping || expired || !connected" @click="stop('terminate')">{{ t('正常结束') }}</button><button class="button danger" :disabled="stopping || expired || !connected" @click="stop('kill')">{{ t('强制结束') }}</button></div>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.gpu-process-overlay { position: fixed; top: 0; bottom: 0; z-index: 24; display: flex; align-items: center; padding-left: var(--panel-left); padding-right: var(--panel-right); color: var(--text); }
.gpu-process-overlay.closing { pointer-events: none; }
.gpu-process-backdrop { position: absolute; inset: 0; background: #17233525; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); opacity: 0; }
.gpu-process-panel { position: relative; z-index: 1; visibility: hidden; display: flex; flex-direction: column; width: 100%; height: 50vh; min-height: 240px; max-height: calc(100vh - 40px); color: var(--text); border: 1px solid var(--surface-border); border-radius: 16px; background: var(--surface-soft); box-shadow: 0 20px 70px #0003; overflow: hidden; transform-origin: top left; outline: none; }
.gpu-process-content { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.gpu-process-overlay :deep(.gpu-process-morph) { position: absolute; z-index: 2; isolation: isolate; overflow: hidden; pointer-events: none; color: var(--text); background: var(--surface-soft); transform-origin: top left; will-change: left, top, width, height, filter; }
.gpu-process-overlay :deep(.gpu-motion-layer) { position: absolute; left: 0; top: 0; margin: 0; min-height: 0; max-height: none; transform-origin: top left; pointer-events: none; box-shadow: none; transition: none; }
.gpu-process-overlay :deep(.gpu-process-particles) { position: absolute; inset: 0; z-index: 3; width: 100%; height: 100%; pointer-events: none; }
.gpu-process-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--line); }
.gpu-process-header h2 { font-size: 17px; font-weight: 600; color: var(--text); }
.gpu-process-header p { color: var(--text-subtle); font-size: 11px; margin-top: 5px; }
.gpu-process-actions { display: flex; gap: 8px; }
.gpu-process-table-wrap { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; background: var(--surface); }
.gpu-process-table { width: 100%; color: var(--text); border-collapse: collapse; table-layout: fixed; font-size: 12px; }
.gpu-process-table th, .gpu-process-table td { padding: 11px 13px; text-align: left; border-bottom: 1px solid var(--line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gpu-process-table th { position: sticky; top: 0; z-index: 1; background: var(--surface-soft); color: var(--text-secondary); font-weight: 500; }
.gpu-process-table th:first-child { width: 88px; }
.gpu-process-table th:nth-child(2) { width: 30%; }
.gpu-process-table th:nth-child(4), .gpu-process-table th:nth-child(5) { width: 115px; }
.gpu-process-table th:nth-child(6), .gpu-process-table th:nth-child(7) { width: 65px; }
.gpu-process-table td { color: var(--text); font-variant-numeric: tabular-nums; height: 43px; }
.gpu-process-table tbody tr:hover { background: var(--accent-soft); }
.gpu-process-table .gpu-process-empty { padding: 40px 20px; text-align: center; color: var(--text-subtle); }
.gpu-stop-button { color: var(--red); }
.gpu-process-footer { display: flex; justify-content: space-between; gap: 15px; padding: 10px 18px; color: var(--text-subtle); font-size: 11px; border-top: 1px solid var(--line); }
.gpu-process-message { padding: 9px 18px; color: var(--green); font-size: 12px; overflow-wrap: anywhere; }
.gpu-process-message.error { color: var(--red); }
.gpu-stop-backdrop { position: absolute; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center; background: #14203355; backdrop-filter: blur(3px); padding: 20px; }
.gpu-stop-confirm { width: 490px; max-width: 100%; }
.gpu-stop-confirm .gpu-stop-warning { color: var(--amber); background: var(--surface-soft); padding: 10px 12px; border-radius: 8px; margin-top: 14px; }
@media (max-width: 1050px) { .gpu-process-table { min-width: 700px; } }
</style>

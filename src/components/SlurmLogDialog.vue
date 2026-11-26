<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { message, t } from '../i18n';
import type { LionApi, SlurmJob, SlurmLogChunk, SlurmLogCursor, SlurmLogStream } from '../types';

const props = defineProps<{ api: LionApi; profileId: string; initialJobId: string; jobs: SlurmJob[] }>();
const emit = defineEmits<{ close: [] }>();
const streams = [{ kind: 'stdout', label: '.out' }, { kind: 'stderr', label: '.err' }] as const;
const preferencesKey = 'lion-slurm-log-preferences';
const preferences = readPreferences();
const jobId = ref(props.initialJobId);
const jobAvailable = computed(() => props.jobs.some(job => job.id === jobId.value));
const stream = ref(preferences.stream);
const follow = ref(preferences.follow);
const status = ref<SlurmLogChunk['status'] | 'loading' | 'error'>('loading');
const content = ref('');
const error = ref('');
const shared = ref(false);
const logView = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const visibleLimit = 1_048_576;
let view = { cursor: undefined as SlurmLogCursor | undefined, decoder: new TextDecoder(), endedWithCarriageReturn: false, reading: false };
let timer: number | undefined;
let disposed = false;

function readPreferences(): { stream: SlurmLogStream; follow: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey) ?? '{}');
    return { stream: saved?.stream === 'stderr' ? 'stderr' : 'stdout', follow: saved?.follow === true };
  } catch {
    return { stream: 'stdout', follow: false };
  }
}

function savePreferences() {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  } catch { /* The dialog remains usable when local storage is unavailable. */ }
}

function changeFollow(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  follow.value = enabled;
  preferences.follow = enabled;
  savePreferences();
}

function stopTimer() {
  window.clearTimeout(timer);
  timer = undefined;
}

async function read() {
  const target = view;
  if (!jobAvailable.value || target.reading) return;
  target.reading = true;
  const started = performance.now();
  try {
    const result = await props.api.readJobLog(props.profileId, jobId.value, stream.value, target.cursor);
    if (disposed || target !== view) return;
    status.value = result.status;
    shared.value = result.shared;
    if (result.status === 'ready') {
      const initial = result.reset || !target.cursor;
      if (initial) {
        target.decoder = new TextDecoder();
        target.endedWithCarriageReturn = false;
        content.value = '';
      }
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      const decoded = target.decoder.decode(bytes, { stream: true });
      if (decoded) {
        // Preserve each progress update as a line. CRLF can span two polls.
        const text = target.endedWithCarriageReturn && decoded.startsWith('\n') ? decoded.slice(1) : decoded;
        target.endedWithCarriageReturn = decoded.endsWith('\r');
        content.value += text.replace(/\r\n?/g, '\n');
      }
      if (content.value.length > visibleLimit) {
        let start = content.value.length - visibleLimit;
        const first = content.value.charCodeAt(start);
        if (first >= 0xdc00 && first <= 0xdfff) start++;
        content.value = content.value.slice(start);
      }
      target.cursor = result.cursor;
      await nextTick();
      if (target === view && logView.value && (initial || follow.value)) logView.value.scrollTop = logView.value.scrollHeight;
    }
  } catch (failure) {
    if (disposed || target !== view) return;
    error.value = String(failure);
    status.value = 'error';
    follow.value = false;
  } finally {
    target.reading = false;
    if (!disposed && target === view && follow.value && jobAvailable.value) {
      stopTimer();
      timer = window.setTimeout(read, Math.max(0, 1000 - (performance.now() - started)));
    }
  }
}

function selectStream(kind: SlurmLogStream) {
  if (stream.value === kind) return;
  stream.value = kind;
  preferences.stream = kind;
  savePreferences();
}

function resetView() {
  stopTimer();
  view = { cursor: undefined, decoder: new TextDecoder(), endedWithCarriageReturn: false, reading: false };
  status.value = 'loading';
  content.value = '';
  shared.value = false;
  logView.value?.scrollTo({ top: 0, left: 0 });
  void read();
}

watch([jobId, stream, jobAvailable], resetView);
watch(follow, enabled => {
  stopTimer();
  if (enabled) void read();
});
onMounted(() => { closeButton.value?.focus(); void read(); });
onUnmounted(() => { disposed = true; stopTimer(); });
</script>

<template>
  <div class="modal-backdrop slurm-log-backdrop" @click.self="emit('close')">
    <section class="modal slurm-log-modal" role="dialog" aria-modal="true" aria-labelledby="slurm-log-title" data-testid="slurm-log-dialog">
      <header class="slurm-log-header">
        <h2 id="slurm-log-title">{{ t('作业') }}</h2>
        <div class="slurm-log-controls">
          <label class="checkbox-row"><input :checked="follow" type="checkbox" @change="changeFollow" />{{ t('跟踪日志') }}</label>
          <div class="segmented-control" role="group" :aria-label="t('日志类型')">
            <button v-for="option in streams" :key="option.kind" type="button" :class="{ active: stream === option.kind }" :aria-pressed="stream === option.kind" @click="selectStream(option.kind)">{{ option.label }}</button>
          </div>
          <button ref="closeButton" type="button" class="icon-button" :aria-label="t('关闭日志')" @click="emit('close')"><Icon name="close" :size="19" /></button>
        </div>
      </header>
      <div class="slurm-log-layout">
        <aside class="slurm-log-jobs" :aria-label="t('可查看日志的作业')">
          <button v-for="job in jobs" :key="job.id" type="button" class="slurm-log-job" :aria-pressed="job.id === jobId" :data-testid="`slurm-log-job-${job.id}`" @click="jobId = job.id">
            <strong>{{ job.name || '—' }}</strong><span>{{ job.id }}</span>
          </button>
          <div v-if="!jobs.length" class="slurm-log-status" role="status">{{ t('暂无自己的运行中作业') }}</div>
        </aside>
        <div class="slurm-log-output">
          <div v-if="shared" class="slurm-log-notes">{{ t('标准输出和标准错误写入同一文件') }}</div>
          <div ref="logView" class="slurm-log-view" tabindex="0" role="region" :aria-label="t('日志内容')">
            <div v-if="!jobAvailable" class="slurm-log-status" role="status">{{ t('该作业已不在运行中') }}</div>
            <div v-else-if="status === 'loading'" class="slurm-log-status" role="status">{{ t('正在读取日志…') }}</div>
            <div v-else-if="status === 'error'" class="slurm-log-status slurm-log-error" role="alert">{{ message(error) }}</div>
            <div v-else-if="status === 'unconfigured'" class="slurm-log-status" role="status">{{ t('此作业未配置该日志') }}</div>
            <div v-else-if="status === 'missing'" class="slurm-log-status" role="status">{{ t('日志文件尚不可用') }}</div>
            <div v-else-if="status === 'unreadable'" class="slurm-log-status" role="status">{{ t('无法读取日志文件') }}</div>
            <div v-else-if="!content" class="slurm-log-status" role="status">{{ t('日志文件为空') }}</div>
            <pre v-if="content" class="slurm-log-text">{{ content }}</pre>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

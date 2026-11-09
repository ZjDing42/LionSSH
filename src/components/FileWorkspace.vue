<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import FileIcon from './FileIcon.vue';
import FileTransfers from './FileTransfers.vue';
import { t, message } from '../i18n';
import type { LionApi, Profile, ServerState } from '../types';
import type { FileContent, FileDrop, FileEntry, FileListing, FileLocation, FileTransfer } from '../file-types';
const FileEditor = defineAsyncComponent(() => import('./FileEditor.vue'));
const props = defineProps<{ visible: boolean; api: LionApi | undefined; profileId: string; profiles: Profile[]; states: Record<string, ServerState>; disabled: boolean }>();
defineEmits<{ back: []; connect: [] }>();
interface Tab extends FileContent { path: string; name: string; text: string; saved: string; loading: boolean; saving: boolean; error: string; zoom: number }
interface Group { path: string; input: string; tree: Record<string, FileEntry[]>; expanded: string[]; selected: string[]; anchor: string; tabs: Tab[]; active: string; loading: string[]; initialized: boolean; navigation: number; error: string }
const groups = reactive<Record<string, Group>>({});
const treeRoot = ref<HTMLElement>();
const nameInput = ref<HTMLInputElement>();
function setNameInput(element: unknown) { if (element instanceof HTMLInputElement) nameInput.value = element; }
const suggestions = ref<string[]>([]);
const suggestionIndex = ref(-1);
const pathFocused = ref(false);
const showHidden = ref(localStorage.getItem('lion-files-hidden') !== 'false');
const sidebarWidth = ref(300);
const dropTarget = ref<string | null>(null);
const clipboard = ref<FileLocation[]>([]);
const editing = ref<{ profileId: string; parent: string; path?: string; name: string; directory: boolean; busy: boolean; error: string } | null>(null);
const menu = ref<{ x: number; y: number; entry?: FileEntry } | null>(null);
const uploadMenu = ref<{ x: number; y: number } | null>(null);
const operationPrompt = ref<{ kind: 'move' | 'delete'; profileId: string; entries: FileEntry[]; target?: string; busy: boolean; error: string } | null>(null);
const moving = ref(false);
const nativeDrag = ref<{ entries: FileEntry[]; profileId: string } | null>(null);
let dragging: { x: number; y: number; entries: FileEntry[]; profileId: string; pointer: number; element: HTMLElement } | null = null;
let suppressClick = false;
const closePrompt = ref<{ group: Group; tab: Tab } | null>(null);
const tasks = ref<FileTransfer[]>([]);
const tools = [ ['upload', '上传'], ['download', '下载'], ['folder-plus', '创建文件夹'], ['file-plus', '创建文件'], ['copy', '复制'], ['paste', '粘贴'], ['edit', '重命名'], ['trash', '删除'] ];
const profile = computed(() => props.profiles.find(p => p.id === props.profileId));
const connected = computed(() => props.states[props.profileId]?.status === 'connected' && !props.disabled);
const group = computed(() => getGroup(props.profileId));
const active = computed(() => group.value.tabs.find(tab => tab.path === group.value.active));
const rows = computed(() => {
  const result: { entry: FileEntry; depth: number }[] = [];
  function visit(path: string, depth: number) {
    if (depth > 80) return;
    for (const entry of group.value.tree[path] || []) {
      if (!showHidden.value && entry.name.startsWith('.')) continue;
      result.push({ entry, depth });
      if (entry.directory && group.value.expanded.includes(entry.path)) visit(entry.path, depth + 1);
    }
  }
  visit(group.value.path, 0); return result;
});
const selectedEntries = computed(() => rows.value.filter(row => group.value.selected.includes(row.entry.path)).map(row => row.entry));
// Selecting an expanded directory and its children transfers each item only once.
const selectedRoots = computed(() => selectedEntries.value.filter(entry => !selectedEntries.value.some(parent => parent.directory && entry.path.startsWith(`${parent.path}/`))));
const destination = computed(() => selectedEntries.value.length === 1 && selectedEntries.value[0]!.directory ? selectedEntries.value[0]!.path : group.value.path);
const inputParent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let completionGeneration = 0;
let unsubFiles: (() => void) | undefined, unsubDrop: (() => void) | undefined;

function getGroup(id: string): Group {
  return groups[id] ||= { path: '', input: '', tree: {}, expanded: [], selected: [], anchor: '', tabs: [], active: '', loading: [], initialized: false, navigation: 0, error: '' };
}
function request<T>(action: string, args: Record<string, unknown>): Promise<T> {
  if (!props.api?.fileRequest) return Promise.reject(Error(t('文件管理器后台不可用')));
  return props.api.fileRequest<T>(action, args);
}
function errorText(error: unknown) { return message(String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, '')); }
async function guarded(operation: () => Promise<unknown>, target = group.value) {
  try { target.error = ''; await operation(); } catch (error) { target.error = errorText(error); }
}
function cachedPath(id: string) { try { return localStorage.getItem(`lion-files-path:${id}`) || '.'; } catch { return '.'; } }
async function load(path: string, navigate = false, id = props.profileId) {
  const current = getGroup(id);
  if (!navigate && current.loading.includes(path)) return;
  const navigation = navigate ? ++current.navigation : current.navigation;
  current.loading.push(path);
  try {
    const result = await request<FileListing>('list', { profileId: id, path });
    current.tree[result.path] = result.entries;
    if (result.path !== path) current.tree[path] = result.entries;
    if (navigate && navigation === current.navigation) {
      current.path = result.path; current.input = result.path; current.selected = []; current.initialized = true;
      localStorage.setItem(`lion-files-path:${id}`, result.path);
      if (props.profileId === id) { suggestions.value = []; editing.value = null; }
    }
    if (navigation === current.navigation) current.error = '';
  } catch (error) {
    if (navigation === current.navigation) throw error;
  } finally { current.loading = current.loading.filter(p => p !== path); }
}
async function refreshTree(path = group.value.path, id = props.profileId) {
  if (!path || props.states[id]?.status !== 'connected' || props.disabled) return;
  const current = getGroup(id), navigation = current.navigation, visited = new Set<string>(), errors: unknown[] = [];
  async function refresh(path: string, depth: number) {
    if (depth > 80 || visited.has(path) || navigation !== current.navigation) return;
    visited.add(path);
    try { await load(path, false, id); }
    catch (error) { errors.push(error); return; }
    // Follow the fresh parent listing so deleted directories are not queried.
    // Closed branches are fetched when expanded, keeping refresh proportional
    // to the open tree rather than scanning the entire remote filesystem.
    for (const entry of current.tree[path] || []) {
      if (entry.directory && current.expanded.includes(entry.path)) await refresh(entry.path, depth + 1);
    }
  }
  await refresh(path, 0);
  if (navigation === current.navigation && errors.length) throw errors[0];
}
async function initialize() {
  if (!props.visible || !props.profileId || !connected.value || group.value.initialized) return;
  const id = props.profileId, current = group.value;
  await guarded(async () => {
    try { await load(cachedPath(id), true, id); }
    catch { await load('.', true, id); }
  }, current);
}
watch(() => [props.visible, props.profileId, connected.value], () => { dismissMenu(); suggestions.value = []; editing.value = null; cancelDrag(); completionGeneration++; void initialize(); }, { immediate: true });
watch(showHidden, value => localStorage.setItem('lion-files-hidden', String(value)));
function complete() {
  clearTimeout(completionTimer);
  const generation = ++completionGeneration, id = props.profileId, path = group.value.input;
  suggestions.value = []; suggestionIndex.value = -1;
  if (!connected.value || !path) return;
  completionTimer = setTimeout(async () => {
    try { const values = await request<string[]>('complete', { profileId: id, path });
      if (generation === completionGeneration && props.profileId === id && pathFocused.value) suggestions.value = values;
    } catch { /* Incomplete and inaccessible prefixes simply have no suggestions. */ }
  }, 160);
}
function choosePath(path: string, navigate: boolean) {
  group.value.input = path; suggestions.value = []; suggestionIndex.value = -1; completionGeneration++;
  if (navigate) void guarded(() => load(path, true)); else { group.value.input = `${path.replace(/\/$/, '')}/`; complete(); }
}
function pathKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); if (suggestions.value.length) suggestionIndex.value = (suggestionIndex.value + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.value.length) % suggestions.value.length;
  } else if (event.key === 'Enter') { event.preventDefault(); choosePath(suggestions.value[suggestionIndex.value] || group.value.input, true); }
  else if (event.key === 'Tab' && suggestions.value.length) { event.preventDefault(); choosePath(suggestions.value[Math.max(0, suggestionIndex.value)]!, false); }
  else if (event.key === 'Escape') { suggestions.value = []; group.value.input = group.value.path; }
}
function select(entry: FileEntry, event: MouseEvent) {
  const current = group.value;
  if (event.shiftKey && current.anchor) {
    const start = rows.value.findIndex(row => row.entry.path === current.anchor), end = rows.value.findIndex(row => row.entry.path === entry.path);
    current.selected = start < 0 ? [entry.path] : rows.value.slice(Math.min(start, end), Math.max(start, end) + 1).map(row => row.entry.path);
  } else if (event.ctrlKey || event.metaKey) { current.selected = current.selected.includes(entry.path) ? current.selected.filter(p => p !== entry.path) : [...current.selected, entry.path]; current.anchor = entry.path; }
  else { current.selected = [entry.path]; current.anchor = entry.path; }
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (entry.directory) { if (event.detail < 2) void toggle(entry); }
    else void open(entry);
  }
}
function enterDirectory(entry: FileEntry) {
  if (entry.directory && connected.value && !editing.value) choosePath(entry.path, true);
}
async function toggle(entry: FileEntry) {
  const current = group.value;
  if (current.expanded.includes(entry.path)) { current.expanded = current.expanded.filter(p => p !== entry.path); return; }
  current.expanded.push(entry.path);
  await guarded(() => refreshTree(entry.path), current);
}
async function open(entry: FileEntry, id = props.profileId) {
  const current = getGroup(id);
  current.active = entry.path;
  if (current.tabs.some(tab => tab.path === entry.path)) return;
  if (current.tabs.length >= 32) { current.error = t('请先关闭一些文件标签（最多 32 个）'); return; }
  const tab: Tab = reactive({ path: entry.path, name: entry.name, kind: 'text', size: entry.size || 0, text: '', saved: '', loading: true, saving: false, error: '', zoom: 1 });
  current.tabs.push(tab);
  try { const content = await request<FileContent>('read', { profileId: id, path: entry.path }); Object.assign(tab, content, { text: content.text || '', saved: content.text || '' }); }
  catch (error) { tab.error = errorText(error); }
  finally { tab.loading = false; }
}
async function save(tab: Tab, id = props.profileId): Promise<boolean> {
  if (tab.saving || tab.kind !== 'text' || tab.saved === tab.text) return tab.saved === tab.text;
  tab.saving = true; const text = tab.text;
  try {
    const result = await request<{ revision: string; size: number }>('save', { profileId: id, path: tab.path, text, encoding: tab.encoding, revision: tab.revision });
    tab.saved = text; tab.revision = result.revision; tab.size = result.size; tab.error = ''; return true;
  } catch (error) { tab.error = errorText(error); return false; }
  finally { tab.saving = false; }
}
function close(tab: Tab, current = group.value) {
  if (tab.text !== tab.saved) { closePrompt.value = { group: current, tab }; return; }
  removeTab(current, tab);
}
function removeTab(current: Group, tab: Tab) {
  const index = current.tabs.indexOf(tab); current.tabs = current.tabs.filter(t => t !== tab);
  if (current.active === tab.path) current.active = current.tabs[Math.max(0, index - 1)]?.path || '';
  closePrompt.value = null;
}
function zoomImage(tab: Tab, event: WheelEvent) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (!event.deltaY) return;
  tab.zoom = Math.max(.1, Math.min(5, Math.round((tab.zoom + (event.deltaY < 0 ? .25 : -.25)) * 100) / 100));
}
async function saveAndClose() {
  const prompt = closePrompt.value; if (!prompt) return;
  const id = Object.keys(groups).find(id => groups[id] === prompt.group);
  if (id && await save(prompt.tab, id)) removeTab(prompt.group, prompt.tab);
}
async function startName(directory: boolean, rename = false) {
  menu.value = null;
  const entry = selectedEntries.value[0];
  if (rename && (!entry || selectedEntries.value.length !== 1)) return;
  const parent = rename ? inputParent(entry!.path) : destination.value;
  editing.value = { profileId: props.profileId, parent, path: rename ? entry!.path : undefined, name: rename ? entry!.name : '', directory: rename ? entry!.directory : directory, busy: false, error: '' };
  if (parent !== group.value.path && !group.value.expanded.includes(parent)) group.value.expanded.push(parent);
  if (!group.value.tree[parent]) await guarded(() => load(parent));
  await nextTick(); nameInput.value?.focus(); nameInput.value?.select();
}
async function commitName() {
  const edit = editing.value; if (!edit || edit.busy) return;
  if (!edit.name.trim()) { editing.value = null; return; }
  edit.busy = true;
  try {
    const result = await request<{ path: string }>(edit.path ? 'rename' : 'create', { profileId: edit.profileId, path: edit.path || edit.parent, name: edit.name, directory: edit.directory });
    const current = getGroup(edit.profileId);
    if (edit.path) {
      for (const tab of current.tabs) if (tab.path === edit.path || tab.path.startsWith(`${edit.path}/`)) {
        const path = `${result.path}${tab.path.slice(edit.path.length)}`;
        if (current.active === tab.path) current.active = path;
        tab.path = path; tab.name = path.split('/').pop()!;
      }
      current.expanded = current.expanded.filter(p => p !== edit.path && !p.startsWith(`${edit.path}/`));
    }
    await load(edit.parent, false, edit.profileId); current.selected = [result.path]; editing.value = null;
    if (!edit.path && !edit.directory) await open({ name: edit.name, path: result.path, directory: false, symlink: false, size: 0, modified: null }, edit.profileId);
  } catch (error) { edit.error = errorText(error); }
  finally { edit.busy = false; }
}
function copied() { clipboard.value = selectedRoots.value.map(entry => ({ profileId: props.profileId, path: entry.path })); menu.value = null; }
async function transfer(sources: FileLocation[], target: FileLocation) { if (sources.length) await request('transfer', { sources, target }); }
async function upload(folder = false, target = destination.value) {
  const id = props.profileId; dismissMenu();
  await guarded(async () => { const paths = await props.api?.fileDialog?.(folder ? 'upload-folder' : 'upload-files');
    if (paths?.length) await transfer(paths.map(path => ({ profileId: null, path })), { profileId: id, path: target }); });
}
async function download() {
  const sources = selectedRoots.value.map(entry => ({ profileId: props.profileId, path: entry.path })); menu.value = null;
  if (!sources.length) return;
  await guarded(async () => { const paths = await props.api?.fileDialog?.('download'); if (paths?.[0]) await transfer(sources, { profileId: null, path: paths[0] }); });
}
async function paste() { const sources = [...clipboard.value], target = { profileId: props.profileId, path: destination.value }; menu.value = null; await guarded(() => transfer(sources, target)); }
function action(icon: string, event?: MouseEvent) {
  if (!connected.value) return;
  if (icon === 'upload') {
    const rect = (event?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    uploadMenu.value = { x: Math.min(rect?.left ?? menu.value?.x ?? 0, innerWidth - 220), y: Math.min(rect?.bottom ?? menu.value?.y ?? 0, innerHeight - 100) };
    menu.value = null;
  } else if (icon === 'download') void download();
  else if (icon === 'folder-plus') void startName(true); else if (icon === 'file-plus') void startName(false);
  else if (icon === 'copy') copied(); else if (icon === 'paste') void paste(); else if (icon === 'edit') void startName(false, true); else if (icon === 'trash') promptDelete();
}
function toolDisabled(icon: string) {
  return !connected.value || !group.value.path || (['download', 'copy', 'edit', 'trash'].includes(icon) && !selectedEntries.value.length)
    || icon === 'edit' && selectedEntries.value.length !== 1 || icon === 'paste' && !clipboard.value.length;
}
function context(event: MouseEvent, entry?: FileEntry) {
  event.preventDefault(); event.stopPropagation();
  if (entry && !group.value.selected.includes(entry.path)) group.value.selected = [entry.path];
  if (!entry) group.value.selected = [];
  menu.value = { x: Math.min(event.clientX, innerWidth - 220), y: Math.max(8, Math.min(event.clientY, innerHeight - 370)), entry };
}
function dismissMenu() { menu.value = null; uploadMenu.value = null; }
async function blankClick(event: MouseEvent) {
  if ((event.target as HTMLElement).closest('.files-row,.files-new,input')) return;
  const current = group.value;
  await commitName(); current.selected = []; current.anchor = '';
}
function promptDelete() {
  dismissMenu();
  if (selectedRoots.value.length) operationPrompt.value = { kind: 'delete', profileId: props.profileId, entries: [...selectedRoots.value], busy: false, error: '' };
}
function relocateTabs(current: Group, from: string, to?: string) {
  for (const tab of [...current.tabs]) if (tab.path === from || tab.path.startsWith(`${from}/`)) {
    if (to) { const next = to + tab.path.slice(from.length); if (current.active === tab.path) current.active = next; tab.path = next; tab.name = next.split('/').pop()!; }
    else removeTab(current, tab);
  }
  current.expanded = current.expanded.filter(path => path !== from && !path.startsWith(`${from}/`));
  for (const path of Object.keys(current.tree)) if (path === from || path.startsWith(`${from}/`)) delete current.tree[path];
}
async function confirmOperation() {
  const prompt = operationPrompt.value; if (!prompt || prompt.busy) return;
  const current = getGroup(prompt.profileId), refresh = new Set([current.path, ...current.expanded]);
  prompt.busy = true; prompt.error = '';
  try {
    for (const entry of [...prompt.entries]) {
      const result = await request<{ path?: string }>(prompt.kind, { profileId: prompt.profileId, path: entry.path, target: prompt.target });
      relocateTabs(current, entry.path, prompt.kind === 'move' ? result.path : undefined);
      refresh.add(inputParent(entry.path)); if (prompt.target) refresh.add(prompt.target);
      prompt.entries = prompt.entries.filter(e => e.path !== entry.path);
    }
    current.selected = []; current.anchor = ''; operationPrompt.value = null;
  } catch (error) { prompt.error = errorText(error); }
  finally {
    prompt.busy = false;
    for (const path of refresh) if (path === current.path || current.expanded.includes(path)) await guarded(() => load(path, false, prompt.profileId), current);
  }
}
function treeKey(event: KeyboardEvent) {
  if ((event.target as HTMLElement).tagName === 'INPUT') return;
  if ((event.ctrlKey || event.metaKey) && ['c', 'v', 'a'].includes(event.key.toLowerCase())) {
    event.preventDefault(); const key = event.key.toLowerCase();
    if (key === 'c') copied(); else if (key === 'v') void paste(); else group.value.selected = rows.value.map(r => r.entry.path);
  } else if (event.key === 'F2') { event.preventDefault(); void startName(false, true); }
  else if (event.key === 'Delete' && connected.value) { event.preventDefault(); promptDelete(); }
  else if (event.key === 'F5') { event.preventDefault(); void guarded(() => refreshTree()); }
  else if (event.key === 'Escape') { editing.value = null; dismissMenu(); cancelDrag(); }
}
function targetAt(x: number, y: number): string | null {
  const element = document.elementFromPoint(x, y);
  if (!element || !treeRoot.value?.contains(element)) return null;
  const row = element.closest<HTMLElement>('[data-file-path]');
  const entry = rows.value.find(r => r.entry.path === row?.dataset.filePath)?.entry;
  return entry ? entry.directory ? entry.path : inputParent(entry.path) : group.value.path || null;
}
function dropped(event: FileDrop) {
  if (!props.visible || !connected.value || !treeRoot.value || operationPrompt.value || closePrompt.value || editing.value || menu.value || uploadMenu.value) { dropTarget.value = null; return; }
  if (event.type === 'leave') { dropTarget.value = null; moving.value = false; return; }
  const scale = event.logical ? 1 : window.devicePixelRatio;
  const target = targetAt((event.x || 0) / scale, (event.y || 0) / scale);
  if (event.sources?.length) {
    const id = event.sources[0]!.profileId;
    const cache = id ? getGroup(id) : null;
    const entries = event.sources.map(source => (nativeDrag.value?.entries || Object.values(cache?.tree || {}).flat()).find(entry => entry.path === source.path));
    const allowed = id === props.profileId && event.sources.every(source => source.profileId === id) && entries.every((entry): entry is FileEntry => Boolean(entry)) && canMoveEntries(entries, target);
    moving.value = true; dropTarget.value = allowed ? target : null;
    if (allowed && target && event.type === 'drop') {
      operationPrompt.value = { kind: 'move', profileId: id!, entries: entries as FileEntry[], target, busy: false, error: '' };
      moving.value = false; dropTarget.value = null;
    }
    return;
  }
  moving.value = false;
  dropTarget.value = target;
  if (target && event.type === 'drop' && event.paths?.length) {
    dropTarget.value = null;
    void guarded(() => transfer(event.paths!.map(path => ({ profileId: null, path })), { profileId: props.profileId, path: target }));
  }
}
function beginDrag(event: PointerEvent, entry: FileEntry) {
  if (nativeDrag.value || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || !connected.value || editing.value) return;
  const element = event.currentTarget as HTMLElement;
  dragging = { x: event.clientX, y: event.clientY, entries: group.value.selected.includes(entry.path) ? [...selectedRoots.value] : [entry], profileId: props.profileId, pointer: event.pointerId, element };
  element.setPointerCapture(event.pointerId);
}
function cancelDrag() {
  if (dragging?.element.hasPointerCapture(dragging.pointer)) dragging.element.releasePointerCapture(dragging.pointer);
  dragging = null; moving.value = false; dropTarget.value = null;
  document.documentElement.classList.remove('files-moving', 'files-move-allowed');
}
function canMove(target: string | null) {
  return dragging && canMoveEntries(dragging.entries, target);
}
function canMoveEntries(entries: FileEntry[], target: string | null) {
  return Boolean(target && entries.length && entries.every(e => target !== inputParent(e.path) && target !== e.path && (!e.directory || !target.startsWith(`${e.path}/`))));
}
async function handOffDrag() {
  if (!dragging || nativeDrag.value || !props.api?.dragFiles) return;
  const gesture = { entries: dragging.entries, profileId: dragging.profileId };
  cancelDrag(); nativeDrag.value = gesture;
  try {
    await updateDropRegion();
    await guarded(() => props.api!.dragFiles!(gesture.entries.map(e => ({ profileId: gesture.profileId, path: e.path }))));
  } finally {
    nativeDrag.value = null; moving.value = false; dropTarget.value = null; suppressClick = false; scheduleDropRegion();
  }
}
function moveDrag(event: PointerEvent) {
  if (!dragging || !event.buttons) { cancelDrag(); return; }
  if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) < 7) return;
  moving.value = true; suppressClick = true;
  group.value.selected = dragging.entries.map(e => e.path);
  // Hand off while still inside the webview so crossing its window edge
  // cannot lose the gesture. Native drops back onto the tree use the same sources.
  const rect = treeRoot.value?.getBoundingClientRect();
  if (rect && (event.clientX < rect.left || event.clientY < rect.top || event.clientX >= rect.right || event.clientY >= rect.bottom)) {
    void handOffDrag();
    return;
  }
  const target = targetAt(event.clientX, event.clientY);
  dropTarget.value = canMove(target) ? target : null;
  document.documentElement.classList.add('files-moving');
  document.documentElement.classList.toggle('files-move-allowed', Boolean(dropTarget.value));
}
function endDrag(event: PointerEvent) {
  if (nativeDrag.value) return;
  if (moving.value && dragging) {
    const target = targetAt(event.clientX, event.clientY);
    if (canMove(target)) operationPrompt.value = { kind: 'move', profileId: dragging.profileId, entries: [...dragging.entries], target: target!, busy: false, error: '' };
  }
  cancelDrag(); setTimeout(() => { suppressClick = false; }, 0);
}
function preventDragClick(event: MouseEvent) { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } }
let regionFrame = 0, lastRegion = '', regionObserver: ResizeObserver | undefined;
function scheduleDropRegion() { cancelAnimationFrame(regionFrame); regionFrame = requestAnimationFrame(() => { void updateDropRegion(); }); }
async function updateDropRegion() {
  if (!props.api?.setFileDropRegion) return;
  const rect = treeRoot.value?.getBoundingClientRect();
  const enabled = props.visible && connected.value && group.value.path && !operationPrompt.value && !closePrompt.value && !editing.value && !menu.value && !uploadMenu.value;
  const own = nativeDrag.value?.profileId === props.profileId ? nativeDrag.value.entries : [];
  const entriesByPath = new Map(rows.value.map(row => [row.entry.path, row.entry]));
  const moveRows = own.length && treeRoot.value ? [...treeRoot.value.querySelectorAll<HTMLElement>('[data-file-path]')].map(element => {
    const bounds = element.getBoundingClientRect(), entry = entriesByPath.get(element.dataset.filePath || '');
    return { top: bounds.top, bottom: bounds.bottom, allowed: Boolean(entry && canMoveEntries(own, entry.directory ? entry.path : inputParent(entry.path))) };
  }).filter(row => rect && row.bottom > rect.top && row.top < rect.bottom) : [];
  const region = enabled && rect ? { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom), scale: devicePixelRatio, moveAllowed: canMoveEntries(own, group.value.path), moveRows } : null;
  const encoded = JSON.stringify(region);
  if (encoded !== lastRegion) { lastRegion = encoded; await props.api.setFileDropRegion(region).catch(error => { lastRegion = ''; group.value.error = errorText(error); }); }
}
watch([() => props.visible, connected, () => group.value.path, () => group.value.error, rows, nativeDrag, operationPrompt, closePrompt, editing, menu, uploadMenu], scheduleDropRegion, { flush: 'post' });
function resize(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement, start = event.clientX, width = sidebarWidth.value;
  handle.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => { sidebarWidth.value = Math.max(230, Math.min(550, width + e.clientX - start)); };
  const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); };
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
}
function fileEvent(event: FileTransfer | { removed: string }) {
  if ('removed' in event) { tasks.value = tasks.value.filter(t => t.id !== event.removed); return; }
  const index = tasks.value.findIndex(t => t.id === event.id);
  const old = tasks.value[index]; if (index < 0) tasks.value.push(event); else tasks.value[index] = event;
  if (event.status === 'completed' && old?.status !== 'completed' && event.target.profileId) {
    const current = groups[event.target.profileId];
    if (current?.initialized) {
      const paths = new Set([current.path, inputParent(event.target.path), ...current.expanded.filter(path => path === event.target.path || path.startsWith(`${event.target.path}/`))]);
      for (const path of paths) void guarded(() => load(path, false, event.target.profileId!), current);
    }
  }
}
function unload(event: BeforeUnloadEvent) {
  if (Object.values(groups).some(g => g.tabs.some(t => t.text !== t.saved))) { event.preventDefault(); event.returnValue = ''; }
}
onMounted(() => {
  unsubFiles = props.api?.onFiles?.(fileEvent); unsubDrop = props.api?.onFileDrop?.(dropped);
  void request<FileTransfer[]>('transfers', {}).then(values => { for (const value of values) if (!tasks.value.some(t => t.id === value.id)) tasks.value.push(value); }).catch(() => {});
  document.addEventListener('pointerdown', dismissMenu); document.addEventListener('click', preventDragClick, true); window.addEventListener('pointermove', moveDrag); window.addEventListener('pointerup', endDrag); window.addEventListener('pointercancel', cancelDrag); window.addEventListener('beforeunload', unload); updateDropRegion();
  regionObserver = new ResizeObserver(scheduleDropRegion); if (treeRoot.value) regionObserver.observe(treeRoot.value); regionObserver.observe(document.body);
  window.addEventListener('resize', scheduleDropRegion); window.addEventListener('scroll', scheduleDropRegion, true);
});
onBeforeUnmount(() => { clearTimeout(completionTimer); completionGeneration++; unsubFiles?.(); unsubDrop?.(); cancelAnimationFrame(regionFrame); regionObserver?.disconnect(); window.removeEventListener('resize', scheduleDropRegion); window.removeEventListener('scroll', scheduleDropRegion, true); void props.api?.setFileDropRegion?.(null); cancelDrag(); document.removeEventListener('click', preventDragClick, true); document.removeEventListener('pointerdown', dismissMenu); window.removeEventListener('pointermove', moveDrag); window.removeEventListener('pointerup', endDrag); window.removeEventListener('pointercancel', cancelDrag); window.removeEventListener('beforeunload', unload); });
</script>

<template>
  <section class="files-page" data-testid="files-page">
    <div class="tool-page-toolbar"><button class="button secondary small" data-testid="files-back" @click="$emit('back')"><Icon name="back" :size="16" />{{ t('返回工作台') }}</button></div>
    <div v-if="!connected" class="files-notice" role="status"><Icon name="info" :size="16" />{{ t('连接服务器后可浏览和编辑文件，未保存内容会保留。') }}<button class="button secondary small" :disabled="disabled" @click="$emit('connect')">{{ t('连接设备') }}</button></div>
    <div v-if="group.error" class="files-notice error" role="alert">{{ group.error }}<button class="icon-button" :title="t('关闭')" @click="group.error = ''"><Icon name="close" :size="15" /></button></div>
    <div class="files-workspace card" :style="{ '--files-width': `${sidebarWidth}px` }">
      <aside class="files-sidebar">
        <div class="files-path">
          <Icon name="folder" :size="16" />
          <input v-model="group.input" data-testid="files-path" role="combobox" :aria-label="t('远程路径')" :aria-expanded="Boolean(pathFocused && suggestions.length)" aria-controls="files-path-choices" :aria-activedescendant="suggestionIndex >= 0 ? `files-choice-${suggestionIndex}` : undefined" :disabled="!connected" autocomplete="off" spellcheck="false" @input="complete" @keydown="pathKey" @focus="pathFocused = true" @blur="pathFocused = false" />
          <button class="icon-button" :title="t('上级目录')" :disabled="!connected || !group.path || group.path === '/'" @click="choosePath(inputParent(group.path), true)"><Icon name="up" :size="15" /></button>
          <ul v-if="pathFocused && suggestions.length" id="files-path-choices" class="files-suggestions" role="listbox"><li v-for="(path, index) in suggestions" :id="`files-choice-${index}`" :key="path" role="option" :aria-selected="index === suggestionIndex" :class="{ active: index === suggestionIndex }" @mousedown.prevent="choosePath(path, true)"><Icon name="folder" :size="14" />{{ path }}</li></ul>
        </div>
        <div class="files-actions"><button v-for="[icon, label] in tools" :key="icon" class="icon-button" :title="t(label!)" :aria-label="t(label!)" :disabled="toolDisabled(icon!)" :data-testid="`files-${icon}`" @click="action(icon!, $event)"><Icon :name="icon!" :size="17" /></button></div>
        <div ref="treeRoot" class="files-tree" :class="{ 'drop-active': dropTarget === group.path }" role="tree" :aria-label="t('远程文件')" aria-multiselectable="true" tabindex="0" @click="blankClick" @keydown="treeKey" @contextmenu="context($event)">
          <div v-if="editing && editing.parent === group.path && !editing.path" class="files-new"><FileIcon :name="editing.name" :directory="editing.directory" /><input :ref="setNameInput" v-model="editing.name" :aria-label="t('名称')" :disabled="editing.busy" @keydown.enter.prevent="commitName" @keydown.esc.prevent="editing = null" /></div>
          <template v-for="{ entry, depth } in rows" :key="entry.path">
            <div class="files-row" :class="{ selected: group.selected.includes(entry.path), 'drop-active': dropTarget === entry.path }" :style="{ paddingLeft: `${12 + depth * 17}px` }" role="treeitem" :aria-level="depth + 1" :aria-expanded="entry.directory ? group.expanded.includes(entry.path) : undefined" :aria-selected="group.selected.includes(entry.path)" :data-file-path="entry.path" :title="entry.path" @click="select(entry, $event)" @contextmenu="context($event, entry)" @pointerdown="beginDrag($event, entry)">
              <Icon v-if="entry.directory" name="chevron" :size="12" class="files-chevron" :class="{ expanded: group.expanded.includes(entry.path) }" /><span v-else class="files-chevron-space" />
              <FileIcon :name="editing?.path === entry.path ? editing.name : entry.name" :directory="entry.directory" :expanded="group.expanded.includes(entry.path)" />
              <input v-if="editing?.path === entry.path" :ref="setNameInput" v-model="editing.name" :aria-label="t('名称')" :disabled="editing.busy" @click.stop @pointerdown.stop @keydown.enter.prevent="commitName" @keydown.esc.prevent="editing = null" />
              <span v-else class="files-row-name">{{ entry.name }}</span><small v-if="entry.symlink" class="files-link">↗</small><span v-if="group.loading.includes(entry.path)" class="files-loading">…</span>
              <button v-if="entry.directory && group.selected.includes(entry.path) && editing?.path !== entry.path" type="button" class="icon-button files-enter" :title="`${t('进入目录')}: ${entry.path}`" :aria-label="t('进入目录')" :disabled="!connected || !!editing" @pointerdown.stop @click.stop="enterDirectory(entry)"><Icon name="arrow" :size="15" /></button>
            </div>
            <div v-if="editing && !editing.path && editing.parent === entry.path" class="files-new" :style="{ paddingLeft: `${41 + depth * 17}px` }"><FileIcon :name="editing.name" :directory="editing.directory" /><input :ref="setNameInput" v-model="editing.name" :aria-label="t('名称')" :disabled="editing.busy" @keydown.enter.prevent="commitName" @keydown.esc.prevent="editing = null" /></div>
          </template>
          <p v-if="editing?.error" class="files-inline-error" role="alert">{{ editing.error }}</p>
          <div v-if="!rows.length && !editing" class="files-tree-empty">{{ t(group.loading.length ? '正在读取目录…' : group.initialized ? '此文件夹为空' : '等待连接') }}</div>
          <div v-if="dropTarget" class="files-drop-label">{{ t(moving ? '松开以移动到' : '松开以上传到') }} {{ dropTarget }}</div>
        </div>
        <div class="files-tree-footer"><span>{{ rows.length }} {{ t('个项目') }}</span><button class="icon-button" :title="t('刷新')" :disabled="!connected || !group.path" @click="guarded(() => refreshTree())"><Icon name="refresh" :size="14" /></button></div>
      </aside>
      <div class="files-divider" role="separator" aria-orientation="vertical" :aria-label="t('调整文件树宽度')" @pointerdown="resize" />
      <main class="files-content">
        <div class="files-tabs" role="tablist" :aria-label="t('打开的文件')"><div v-for="tab in group.tabs" :key="tab.path" class="files-tab" :class="{ active: group.active === tab.path }" role="tab" :aria-selected="group.active === tab.path" :title="tab.path" tabindex="0" @click="group.active = tab.path" @keydown.enter="group.active = tab.path"><FileIcon :name="tab.name" :size="14" /><span>{{ tab.name }}</span><span v-if="tab.text !== tab.saved" class="files-dirty" :title="t('未保存')">●</span><button class="icon-button" :title="t('关闭文件')" :disabled="tab.saving" @click.stop="close(tab)"><Icon name="close" :size="13" /></button></div></div>
        <div v-if="active" class="files-content-toolbar"><span :title="active.path">{{ active.path }}</span><template v-if="active.kind === 'image'"><button class="icon-button" :title="t('缩小')" @click="active.zoom = Math.max(.1, active.zoom - .25)">−</button><button class="files-zoom" :title="t('恢复缩放')" @click="active.zoom = 1">{{ Math.round(active.zoom * 100) }}%</button><button class="icon-button" :title="t('放大')" @click="active.zoom = Math.min(5, active.zoom + .25)">+</button></template><button v-else class="icon-button" :title="t('保存（Ctrl+S）')" :disabled="!connected || active.loading || active.saving || active.text === active.saved" @click="save(active)"><Icon name="save" :size="16" /></button></div>
        <div class="files-panes"><template v-for="tab in group.tabs" :key="tab.path"><div v-show="group.active === tab.path" class="files-pane" role="tabpanel"><div v-if="tab.loading" class="files-empty">{{ t('正在打开文件…') }}</div><template v-else><div v-if="tab.error" class="files-notice error" role="alert">{{ tab.error }}</div><div v-if="tab.kind === 'image'" class="files-image" @wheel="zoomImage(tab, $event)"><img :src="tab.data" :alt="tab.name" :style="{ width: `${tab.zoom * 100}%`, maxWidth: `${tab.zoom * 100}%` }" draggable="false" /></div><FileEditor v-else-if="tab.revision" v-model="tab.text" :path="tab.path" :active="visible && group.active === tab.path" :disabled="!connected || tab.saving" @save="save(tab)" @error="tab.error = $event" /></template></div></template><div v-if="!group.tabs.length" class="files-empty"><Icon name="folder" :size="48" /><strong>{{ t('选择文件开始浏览') }}</strong><span>{{ t('文本可编辑 · 图片可预览') }}</span></div></div>
        <footer class="files-status"><span>{{ active?.kind === 'image' ? t('图片预览') : active?.encoding?.toUpperCase() || 'SFTP' }}</span><span v-if="active?.text !== active?.saved">{{ t('未保存') }}</span><span class="files-status-end">{{ profile?.name }}</span></footer>
      </main>
      <FileTransfers :tasks="tasks" :profiles="profiles" :api="api" @error="group.error = $event" />
    </div>
    <Teleport to="body">
      <div v-if="menu" class="files-context" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @pointerdown.stop>
        <button v-for="[icon, label] in tools" :key="icon" role="menuitem" :disabled="toolDisabled(icon!)" @click="action(icon!, $event); menu = null"><Icon :name="icon!" :size="15" />{{ t(label!) }}</button>
        <button role="menuitem" :disabled="!connected" @click="upload(true)"><Icon name="folder" :size="15" />{{ t('上传文件夹…') }}</button><hr /><button role="menuitemcheckbox" :aria-checked="showHidden" @click="showHidden = !showHidden; menu = null"><Icon name="eye" :size="15" />{{ t(showHidden ? '隐藏隐藏文件' : '显示隐藏文件') }}</button><button role="menuitem" :disabled="!connected" @click="guarded(() => refreshTree()); menu = null"><Icon name="refresh" :size="15" />{{ t('刷新') }}<kbd>F5</kbd></button>
      </div>
      <div v-if="uploadMenu" class="files-context" role="menu" :aria-label="t('上传')" :style="{ left: `${uploadMenu.x}px`, top: `${uploadMenu.y}px` }" @pointerdown.stop>
        <button role="menuitem" @click="upload(false)"><Icon name="file" :size="15" />{{ t('上传文件…') }}</button>
        <button role="menuitem" @click="upload(true)"><Icon name="folder" :size="15" />{{ t('上传文件夹…') }}</button>
      </div>
      <div v-if="operationPrompt" class="modal-backdrop"><section class="modal files-operation" role="alertdialog" aria-modal="true" aria-labelledby="files-operation-title">
        <h2 id="files-operation-title">{{ t(operationPrompt.kind === 'move' ? '确认移动' : '确认删除') }}</h2>
        <p>{{ t(operationPrompt.kind === 'move' ? '将以下项目移动到目标目录：' : '删除以下项目？文件夹中的内容也会删除，此操作无法撤销。') }}</p>
        <ul><li v-for="entry in operationPrompt.entries" :key="entry.path"><Icon :name="entry.directory ? 'folder' : 'file'" :size="15" /><span>{{ entry.path }}</span></li></ul>
        <p v-if="operationPrompt.target" class="files-operation-target">{{ t('目标目录') }}：{{ operationPrompt.target }}</p>
        <p v-if="operationPrompt.kind === 'delete' && getGroup(operationPrompt.profileId).tabs.some(tab => tab.text !== tab.saved && operationPrompt!.entries.some(e => tab.path === e.path || tab.path.startsWith(`${e.path}/`)))">{{ t('这些项目中未保存的编辑内容也会丢弃。') }}</p>
        <p v-if="operationPrompt.error" class="files-inline-error" role="alert">{{ operationPrompt.error }}</p>
        <div class="modal-actions"><button class="button secondary" :disabled="operationPrompt.busy" @click="operationPrompt = null">{{ t('取消') }}</button><button class="button primary" :disabled="operationPrompt.busy" data-testid="files-confirm-operation" @click="confirmOperation">{{ t(operationPrompt.kind === 'move' ? '确认移动' : '确认删除') }}</button></div>
      </section></div>
      <div v-if="closePrompt" class="modal-backdrop"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="files-unsaved-title"><h2 id="files-unsaved-title">{{ t('保存文件修改？') }}</h2><p>{{ closePrompt.tab.path }}</p><p v-if="closePrompt.tab.error" class="files-inline-error">{{ closePrompt.tab.error }}</p><div class="modal-actions"><button class="button secondary" @click="closePrompt = null">{{ t('取消') }}</button><button class="button secondary" :disabled="closePrompt.tab.saving" @click="removeTab(closePrompt.group, closePrompt.tab)">{{ t('不保存') }}</button><button class="button primary" :disabled="closePrompt.tab.saving" @click="saveAndClose">{{ t('保存') }}</button></div></section></div>
    </Teleport>
  </section>
</template>

<style>
.files-workspace { display:grid; grid-template-columns:var(--files-width) 5px minmax(0,1fr); grid-template-rows:minmax(0,1fr) auto; flex:1; min-height:0; margin-bottom:0; padding:0; overflow:hidden; border-radius:12px; }
.files-sidebar { display:flex; flex-direction:column; min-height:0; background:var(--surface-soft); min-width:0; }.files-path { position:relative; display:flex; align-items:center; gap:7px; margin:12px 10px 5px; padding:2px 6px; border:1px solid var(--surface-border); border-radius:5px; background:var(--surface-input); }.files-path input { width:100%; min-width:0; background:transparent; border:0; outline:none; color:var(--text); padding:6px 0; font:12px Consolas,monospace; }.files-path .icon-button { padding:3px; }
.files-suggestions { position:absolute; top:100%; left:-1px; right:-1px; z-index:20; margin:3px 0 0; padding:4px; max-height:260px; overflow:auto; list-style:none; background:var(--surface-input); border:1px solid var(--surface-border); box-shadow:0 10px 26px #0003; border-radius:5px; }.files-suggestions li { display:flex; align-items:center; gap:7px; padding:8px; font:12px Consolas,monospace; overflow-wrap:anywhere; cursor:pointer; }.files-suggestions li:hover,.files-suggestions li.active { background:var(--accent-soft); color:var(--blue); }
.files-actions { display:flex; align-items:center; justify-content:space-between; padding:5px 9px 9px; border-bottom:1px solid var(--line); }.files-actions .icon-button { padding:7px; }.files-tree { flex:1; overflow:auto; min-height:0; padding:7px 0; position:relative; outline:none; }.files-row,.files-new { display:flex; align-items:center; gap:7px; min-height:30px; padding-right:10px; cursor:default; font-size:12px; user-select:none; }.files-row:hover { background:var(--surface-border); }.files-row.selected { background:var(--accent-soft); color:var(--blue); }.files-row-name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }.files-chevron { transition:transform .12s; }.files-chevron.expanded { transform:rotate(90deg); }.files-chevron-space { width:12px; flex-shrink:0; }.files-row input,.files-new input { min-width:0; flex:1; border:1px solid var(--blue); color:var(--text); background:var(--surface-input); padding:4px; border-radius:2px; font-size:12px; }.files-new { padding-left:31px; }.files-tree-empty { padding:20px 14px; font-size:12px; color:var(--muted); }.files-inline-error { color:var(--red); font-size:12px; padding:5px 12px; overflow-wrap:anywhere; }.files-loading { margin-left:auto; }.files-tree-footer { padding:4px 10px 4px 14px; display:flex; align-items:center; justify-content:space-between; color:var(--muted); font-size:10px; border-top:1px solid var(--line); }.files-tree-footer .icon-button { padding:5px; }.drop-active { outline:2px solid var(--blue); outline-offset:-2px; }.files-drop-label { position:sticky; bottom:0; padding:8px; margin:0 8px; background:var(--accent-soft); border:1px solid var(--blue); color:var(--blue); font-size:11px; overflow-wrap:anywhere; }
.files-divider { background:var(--line); cursor:col-resize; touch-action:none; }.files-divider:hover { background:var(--blue); }.files-content { min-width:0; min-height:0; display:flex; flex-direction:column; background:var(--surface-input); }.files-tabs { height:39px; display:flex; flex-shrink:0; overflow:auto hidden; background:var(--surface-soft); border-bottom:1px solid var(--line); }.files-tab { display:flex; align-items:center; gap:7px; padding:0 8px 0 13px; border-right:1px solid var(--line); border-top:2px solid transparent; min-width:125px; max-width:235px; color:var(--muted); cursor:pointer; font-size:12px; }.files-tab.active { color:var(--text); border-top-color:var(--blue); background:var(--surface-input); }.files-tab>span:first-of-type { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.files-tab .icon-button { margin-left:auto; padding:3px; }.files-dirty { color:var(--amber); font-size:8px; }.files-content-toolbar { height:34px; padding:0 12px; display:flex; align-items:center; gap:5px; border-bottom:1px solid var(--line); font-size:11px; color:var(--muted); }.files-content-toolbar>span { flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }.files-content-toolbar .icon-button { padding:4px; }.files-zoom { border:0; background:none; color:var(--muted); font-size:11px; }.files-panes { flex:1; min-height:0; position:relative; }.files-pane { position:absolute; inset:0; display:flex; flex-direction:column; min-height:0; }.file-editor { flex:1; min-height:0; overflow:hidden; }.files-empty { height:100%; display:flex; flex-direction:column; justify-content:center; align-items:center; gap:14px; color:var(--muted); font-size:12px; }.files-empty>svg { opacity:.45; margin-bottom:5px; }.files-empty strong { font-size:15px; font-weight:500; }.files-image { flex:1; min-height:0; overflow:auto; padding:24px; background:repeating-conic-gradient(var(--surface-soft) 0% 25%,var(--surface-input) 0% 50%) 50% / 20px 20px; }.files-image img { display:block; height:auto; margin:auto; object-fit:contain; }.files-status { display:flex; align-items:center; gap:15px; height:24px; padding:0 12px; font-size:10px; background:var(--accent-soft); color:var(--muted); border-top:1px solid var(--line); }.files-status-end { margin-left:auto; }.files-notice { display:flex; align-items:center; gap:10px; padding:9px 12px; margin-bottom:8px; font-size:12px; background:var(--surface-soft); border:1px solid var(--line); border-radius:5px; overflow-wrap:anywhere; }.files-notice.error { color:var(--red); }.files-notice>.icon-button { margin-left:auto; }.files-pane>.files-notice { margin:0; border-radius:0; }
.files-context { position:fixed; z-index:1500; width:215px; padding:5px; border:1px solid var(--surface-border); border-radius:7px; background:var(--surface-input); box-shadow:0 12px 35px #0004; }.files-context button { display:flex; width:100%; align-items:center; gap:10px; padding:8px 10px; border:0; background:none; color:var(--text); font-size:12px; text-align:left; border-radius:3px; }.files-context button:hover:not(:disabled) { background:var(--accent-soft); }.files-context kbd { margin-left:auto; color:var(--muted); }.files-context hr { border:0; border-top:1px solid var(--line); margin:4px; }
.files-actions { padding-inline:6px; }.files-actions .icon-button { padding:5px; }.files-moving * { cursor:not-allowed!important; }.files-moving.files-move-allowed * { cursor:move!important; }.files-row.drop-active { background:var(--accent-soft); color:var(--blue); }.files-drop-label { pointer-events:none; }.files-operation ul { list-style:none; padding:0; max-height:220px; overflow:auto; }.files-operation li { display:flex; gap:8px; align-items:start; margin:8px 0; overflow-wrap:anywhere; }.files-operation li svg { flex-shrink:0; }.files-operation-target { overflow-wrap:anywhere; }
@media(max-width:1100px) { .files-workspace { --files-width:250px!important; }.files-actions .icon-button { padding:5px; } }
.files-enter { margin-left:auto; flex-shrink:0; padding:4px; }
</style>

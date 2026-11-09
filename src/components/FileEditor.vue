<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment, Text } from '@codemirror/state';
import { indentWithTab, undo, redo, undoDepth, redoDepth, selectAll } from '@codemirror/commands';
import { closeSearchPanel, openSearchPanel, searchPanelOpen, getSearchQuery, setSearchQuery } from '@codemirror/search';
import { LanguageDescription, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { language as interfaceLanguage, t } from '../i18n';
import { createFileDocument } from '../file-newlines';
const props = defineProps<{ modelValue: string; path: string; disabled: boolean; active: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: []; error: [value: string] }>();
const root = ref<HTMLDivElement>();
const menuRoot = ref<HTMLDivElement>();
const menu = ref<{ x: number; y: number; ready: boolean; selected: boolean; undo: boolean; redo: boolean } | null>(null);
const modifier = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
let clipboardGeneration = 0;
const editable = new Compartment();
const language = new Compartment();
const phrases = new Compartment();
const searchPhrases = {
  Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全部选择',
  'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配', replace: '替换', 'replace all': '全部替换', close: '关闭',
  'Go to line': '跳转到行', go: '跳转', 'current match': '当前匹配', 'on line': '所在行',
  'replaced match on line $': '已替换第 $ 行的匹配', 'replaced $ matches': '已替换 $ 处匹配',
};
function translatedPhrases() { return EditorState.phrases.of(interfaceLanguage.value.resolved === 'zh' ? searchPhrases : {}); }
function editableExtensions() { return [EditorView.editable.of(!props.disabled), EditorState.readOnly.of(props.disabled)]; }
let editor: EditorView | undefined;
let fileDocument: ReturnType<typeof createFileDocument>;
let generation = 0;
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--surface-input)', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, Menlo, monospace', fontSize: '13px', lineHeight: '1.65' },
  '.cm-content': { caretColor: 'var(--text)', padding: '12px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface-soft)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--progress-track)' },
  '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--surface-soft)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-panel.cm-search': { padding: '8px 30px 8px 10px', color: 'var(--text)' },
  '.cm-panel .cm-textfield': { color: 'var(--text)', background: 'var(--surface-input)', border: '1px solid var(--surface-border)', borderRadius: '4px', padding: '4px 6px' },
  '.cm-panel .cm-button': { color: 'var(--text)', background: 'var(--surface-input)', border: '1px solid var(--surface-border)', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer' },
  '.cm-panel .cm-button:hover': { background: 'var(--accent-soft)' },
  '.cm-panel input:focus-visible, .cm-panel button:focus-visible': { outline: '1px solid var(--blue)', outlineOffset: '1px' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', margin: '4px 6px' },
  '.cm-panel input[type=checkbox]': { accentColor: 'var(--blue)', margin: '0' },
  '.cm-panel button[name=close]': { color: 'var(--text)', background: 'transparent', top: '5px', right: '5px' },
  '.cm-searchMatch': { backgroundColor: '#b78b2340' },
});
async function openMenu(event: MouseEvent) {
  event.preventDefault(); event.stopPropagation();
  if (!editor || !props.active || (event.target as Element)?.closest('.cm-panels, .cm-tooltip')) return;
  const state = editor.state, caret = editor.coordsAtPos(state.selection.main.head);
  const x = event.clientX || caret?.left || 8, y = event.clientY || caret?.bottom || 8;
  menu.value = { x, y, ready: false, selected: state.selection.ranges.some(range => !range.empty), undo: undoDepth(state) > 0, redo: redoDepth(state) > 0 };
  const opened = menu.value;
  await nextTick();
  if (menu.value !== opened || !menuRoot.value) return;
  const { width, height } = menuRoot.value.getBoundingClientRect();
  const place = (point: number, size: number, viewport: number) => Math.max(8, Math.min(point + size <= viewport - 8 ? point : point - size, viewport - size - 8));
  opened.x = place(x, width, innerWidth); opened.y = place(y, height, innerHeight); opened.ready = true;
}
function closeMenuOnEscape(event: KeyboardEvent) {
  if (menu.value && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); menu.value = null; }
}
async function editAction(action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') {
  menu.value = null;
  const view = editor; if (!view || !props.active) return;
  if (props.disabled && !['copy', 'selectAll'].includes(action)) return;
  view.focus();
  if (action === 'undo') { undo(view); return; }
  if (action === 'redo') { redo(view); return; }
  if (action === 'selectAll') { selectAll(view); return; }
  const state = view.state, generation = clipboardGeneration;
  const current = () => editor === view && props.active && !props.disabled && clipboardGeneration === generation && view.state === state;
  try {
    if (action === 'paste') {
      if (!navigator.clipboard?.readText) throw Error(t('当前环境无法访问剪贴板，请使用粘贴快捷键。'));
      const text = await navigator.clipboard.readText();
      if (current() && text) view.dispatch({ ...state.replaceSelection(Text.of(text.replace(/\r\n?/g, '\n').split('\n'))), userEvent: 'input.paste', scrollIntoView: true });
    } else {
      const text = state.selection.ranges.filter(range => !range.empty).map(range => state.sliceDoc(range.from, range.to)).join(state.lineBreak);
      if (!text) return;
      if (!navigator.clipboard?.writeText) throw Error(t('当前环境无法访问剪贴板，请使用复制快捷键。'));
      await navigator.clipboard.writeText(text);
      if (action === 'cut' && current()) view.dispatch({ ...state.replaceSelection(''), userEvent: 'delete.cut', scrollIntoView: true });
    }
  } catch (error) {
    if (editor === view && clipboardGeneration === generation) emit('error', t(action === 'paste' ? '粘贴失败：{error}' : '复制失败：{error}', { error: String(error instanceof Error ? error.message : error) }));
  }
}
function updatePhrases() {
  const view = editor; if (!view) return;
  const opened = searchPanelOpen(view.state), query = getSearchQuery(view.state), focused = document.activeElement as HTMLElement | null;
  const restoreFocus = focused && !view.dom.contains(focused);
  if (opened) closeSearchPanel(view);
  view.dispatch({ effects: phrases.reconfigure(translatedPhrases()) });
  if (opened) { openSearchPanel(view); view.dispatch({ effects: setSearchQuery.of(query) }); if (restoreFocus) focused?.focus(); }
}
async function loadLanguage() {
  const request = ++generation;
  const match = LanguageDescription.matchFilename(languages, props.path);
  const support = match ? await match.load().catch(() => null) : null;
  if (editor && generation === request) editor.dispatch({ effects: language.reconfigure(support || []) });
}
onMounted(() => {
  window.addEventListener('keydown', closeMenuOnEscape, true);
  fileDocument = createFileDocument(props.modelValue);
  editor = new EditorView({ parent: root.value, state: EditorState.create({ doc: fileDocument.doc, extensions: [
    basicSetup, theme, syntaxHighlighting(HighlightStyle.define([
      { tag: tags.keyword, color: 'var(--blue)' }, { tag: [tags.string, tags.regexp], color: 'var(--green)' },
      { tag: [tags.number, tags.bool, tags.null], color: 'var(--purple)' }, { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
      { tag: [tags.function(tags.variableName), tags.typeName], color: 'var(--amber)' },
    ])), language.of([]), phrases.of(translatedPhrases()), editable.of(editableExtensions()),
    ...fileDocument.extensions,
    keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { emit('save'); return true; } }, indentWithTab]),
    EditorView.updateListener.of(update => { if (update.docChanged) emit('update:modelValue', fileDocument.serialize(update.state)); }),
    EditorView.contentAttributes.of({ 'aria-label': props.path, spellcheck: 'false' }),
  ] }) });
  void loadLanguage();
});
watch(() => props.path, loadLanguage);
watch(() => props.disabled, () => editor?.dispatch({ effects: editable.reconfigure(editableExtensions()) }));
watch(() => [props.path, props.active, props.disabled], () => { clipboardGeneration++; menu.value = null; }, { flush: 'sync' });
watch(() => interfaceLanguage.value.resolved, updatePhrases);
watch(() => props.modelValue, value => { if (editor && value !== fileDocument.serialize(editor.state)) editor.dispatch(fileDocument.replace(editor.state, value)); });
onBeforeUnmount(() => { window.removeEventListener('keydown', closeMenuOnEscape, true); generation++; clipboardGeneration++; editor?.destroy(); editor = undefined; });
</script>
<template>
  <div ref="root" class="file-editor" @contextmenu="openMenu" />
  <Teleport to="body"><div v-if="menu" class="editor-menu-backdrop" @pointerdown.self="menu = null" @contextmenu.prevent="menu = null" @keydown.esc.prevent="menu = null">
    <div ref="menuRoot" class="files-context" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px`, visibility: menu.ready ? 'visible' : 'hidden' }" @pointerdown.prevent>
      <button role="menuitem" :disabled="disabled || !menu.undo" @click="editAction('undo')">{{ t('撤销') }}<kbd>{{ modifier }}+Z</kbd></button>
      <button role="menuitem" :disabled="disabled || !menu.redo" @click="editAction('redo')">{{ t('重做') }}<kbd>{{ modifier }}+Shift+Z</kbd></button><hr />
      <button role="menuitem" :disabled="disabled || !menu.selected" @click="editAction('cut')">{{ t('剪切') }}<kbd>{{ modifier }}+X</kbd></button>
      <button role="menuitem" :disabled="!menu.selected" @click="editAction('copy')">{{ t('复制') }}<kbd>{{ modifier }}+C</kbd></button>
      <button role="menuitem" :disabled="disabled" @click="editAction('paste')">{{ t('粘贴') }}<kbd>{{ modifier }}+V</kbd></button><hr />
      <button role="menuitem" @click="editAction('selectAll')">{{ t('全选') }}<kbd>{{ modifier }}+A</kbd></button>
    </div>
  </div></Teleport>
</template>
<style>.editor-menu-backdrop { position:fixed; inset:0; z-index:1499; }</style>

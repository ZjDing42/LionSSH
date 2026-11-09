import { ChangeSet, EditorState, StateEffect, StateField, Text } from '@codemirror/state';
import type { ChangeSpec } from '@codemirror/state';
import { invertedEffects } from '@codemirror/commands';

type Separator = 'n' | 'r' | 'b';
type Newlines = { endings: Text; preferred: Separator };
const separators = { n: '\n', r: '\r', b: '\r\n', '': '' };

function parse(source: string) {
  const breaks = source.match(/\r\n?|\n/g) || [];
  const counts = { n: 0, r: 0, b: 0 };
  const codes = breaks.map(value => {
    const code = value === '\r\n' ? 'b' : value === '\r' ? 'r' : 'n';
    counts[code]++; return code;
  });
  let preferred: Separator = codes[0] || 'n';
  for (const code of ['n', 'r', 'b'] as const) if (counts[code] > counts[preferred]) preferred = code;
  return { doc: Text.of(source.split(/\r\n?|\n/)), newlines: { endings: Text.of([...codes, '']), preferred } };
}

// CodeMirror displays normalized lines. Keep the original separator for each
// boundary separately, using its persistent text tree to share undo snapshots.
export function createFileDocument(source: string) {
  const initial = parse(source);
  const restore = StateEffect.define<Newlines>();
  const newlines = StateField.define<Newlines>({
    create: () => initial.newlines,
    update(value, transaction) {
      let restored: Newlines | undefined;
      for (const effect of transaction.effects) if (effect.is(restore)) restored = effect.value;
      if (restored) return restored;
      if (!transaction.docChanged) return value;
      const changes: ChangeSpec[] = [];
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        const first = transaction.startState.doc.lineAt(from).number;
        const last = transaction.startState.doc.lineAt(to).number;
        if (first === last && inserted.lines === 1) return;
        changes.push({
          from: value.endings.line(first).from, to: value.endings.line(last).from,
          insert: Text.of([...Array(inserted.lines - 1).fill(value.preferred), '']),
        });
      });
      return changes.length ? { ...value, endings: ChangeSet.of(changes, value.endings.length).apply(value.endings) } : value;
    },
  });
  let cachedDoc = initial.doc, cachedEndings = initial.newlines.endings, cachedText = source;
  return {
    doc: initial.doc,
    extensions: [newlines, invertedEffects.of(transaction => transaction.docChanged
      ? [restore.of(transaction.startState.field(newlines))] : [])],
    serialize(state: EditorState) {
      const endings = state.field(newlines).endings;
      if (state.doc === cachedDoc && endings === cachedEndings) return cachedText;
      const cursor = endings.iterLines(), parts: string[] = [];
      for (const line of state.doc.iterLines()) parts.push(line, separators[cursor.next().value as Separator | '']);
      cachedDoc = state.doc; cachedEndings = endings; cachedText = parts.join('');
      return cachedText;
    },
    replace(state: EditorState, value: string) {
      const replacement = parse(value);
      return { changes: { from: 0, to: state.doc.length, insert: replacement.doc }, effects: restore.of(replacement.newlines) };
    },
  };
}

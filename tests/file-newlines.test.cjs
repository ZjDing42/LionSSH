'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const { EditorState, Transaction } = require('@codemirror/state');
const { history, undo, redo, isolateHistory } = require('@codemirror/commands');
const exportsObject = {};
const file = path.join(__dirname, '../src/file-newlines.ts');
vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject, require }, { filename: file });
const { createFileDocument } = exportsObject;

function editor(source) {
  const document = createFileDocument(source);
  const view = { state: EditorState.create({ doc: document.doc, extensions: [...document.extensions, history()] }), dispatch(transaction) { view.state = transaction.state; } };
  return { view, document, text: () => document.serialize(view.state), edit: spec => view.dispatch(view.state.update({ annotations: isolateHistory.of('full'), ...spec })) };
}

test('LF, CRLF, CR and mixed boundaries display as lines and round-trip unchanged', () => {
  for (const source of ['', 'abc', '\n', 'a\nb\n', 'a\r\nb\r\n', '\ra\rb\r', 'a\r\nb\nc\rd\r\n']) {
    const e = editor(source);
    assert.equal(e.view.state.doc.lines, source.split(/\r\n?|\n/).length);
    assert.equal(e.text(), source);
    e.edit({ changes: { from: 0, insert: 'X' } });
    assert.equal(e.text(), 'X' + source);
    assert.equal(undo(e.view), true); assert.equal(e.text(), source);
    assert.equal(redo(e.view), true); assert.equal(e.text(), 'X' + source);
  }
});

test('mixed newline deletion, multi-range edits and grouped undo preserve original separators', () => {
  const e = editor('a\rb\nc\rd\r');
  e.edit({ changes: [{ from: 1, to: 2, insert: '' }, { from: 5, insert: '\nX' }] });
  assert.equal(e.text(), 'ab\nc\rX\rd\r');
  undo(e.view); assert.equal(e.text(), 'a\rb\nc\rd\r');
  redo(e.view); assert.equal(e.text(), 'ab\nc\rX\rd\r');
  const grouped = editor('a\r\n\nb\rc');
  grouped.edit({ changes: { from: 1, to: 2 }, annotations: Transaction.userEvent.of('delete.backward') });
  grouped.edit({ changes: { from: 1, to: 2 }, annotations: Transaction.userEvent.of('delete.backward') });
  assert.equal(grouped.text(), 'ab\rc');
  undo(grouped.view); assert.equal(grouped.text(), 'a\r\n\nb\rc');
  redo(grouped.view); assert.equal(grouped.text(), 'ab\rc');
});

test('inserted and pasted lines use the file convention; external replacement restores its own endings', () => {
  const e = editor('a\r\nb\r\n');
  e.edit({ changes: { from: 1, insert: '\rX\nY\r\nZ' } });
  assert.equal(e.text(), 'a\r\nX\r\nY\r\nZ\r\nb\r\n');
  e.edit(e.document.replace(e.view.state, '\rprogress\nlast'));
  assert.equal(e.text(), '\rprogress\nlast');
  e.edit({ changes: { from: e.view.state.doc.length, insert: '\nnew' } });
  assert.equal(e.text(), '\rprogress\nlast\rnew');
  undo(e.view); undo(e.view);
  assert.equal(e.text(), 'a\r\nX\r\nY\r\nZ\r\nb\r\n');
});

test('large training progress logs stay in short lines and retain every original CR on save', () => {
  const source = '\rTraining progress: 10%|#         | 100/1000 [00:01<00:09, 100it/s]'.repeat(28000) + '\ncompleted\n';
  const e = editor(source);
  assert.ok(Buffer.byteLength(source) > 1024 * 1024);
  assert.equal(e.view.state.doc.lines, 28003);
  assert.ok(e.view.state.doc.line(2).length < 100);
  e.edit({ changes: { from: e.view.state.doc.length, insert: 'checked' } });
  assert.equal(e.text(), source + 'checked');
  undo(e.view); assert.equal(e.text(), source);
});

test('mixed newline edits match raw string splices through repeated undo and redo', () => {
  const source = 'one\r\ntwo\nthree\rfour\r\nfive\n';
  const e = editor(source), snapshots = [source];
  let raw = source, seed = 4238;
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  for (let turn = 0; turn < 60; turn++) {
    const positions = [0];
    for (let i = 0; i < raw.length;) { i += raw.slice(i, i + 2) === '\r\n' ? 2 : 1; positions.push(i); }
    const from = random(positions.length), to = from + random(positions.length - from);
    const insert = ['x', '\n', '\rX\nY', '\r\nZ', ''][random(5)];
    if (from === to && !insert) continue;
    raw = raw.slice(0, positions[from]) + insert.replace(/\r\n?|\n/g, '\r\n') + raw.slice(positions[to]);
    e.edit({ changes: { from, to, insert } });
    assert.equal(e.text(), raw, `edit ${turn}`); snapshots.push(raw);
  }
  for (let i = snapshots.length - 2; i >= 0; i--) { assert.equal(undo(e.view), true); assert.equal(e.text(), snapshots[i]); }
  for (let i = 1; i < snapshots.length; i++) { assert.equal(redo(e.view), true); assert.equal(e.text(), snapshots[i]); }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { ServiceHarness } = require('./helpers/service-harness.cjs');
const { localSshServer } = require('./helpers/local-ssh.cjs');
const { profile, delay } = require('./helpers/fixtures.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = path.resolve(__dirname, '../test-output'); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'files-backend-'));
  const remote = path.join(directory, 'remote'), other = path.join(directory, 'other'), local = path.join(directory, 'local');
  await Promise.all([remote, other].map(r => fs.mkdir(path.join(r, 'home/tester'), { recursive: true }))); await fs.mkdir(local);
  const first = await localSshServer({ sftpRoot: remote, sftpReadDelay: 6 });
  const second = await localSshServer({ sftpRoot: other });
  const backend = new ServiceHarness(path.join(directory, 'data'));
  t.after(async () => { await backend.stop(); await first.close(); await second.close(); assert.equal(path.dirname(directory), root); await fs.rm(directory, { recursive: true, force: true }); });
  await backend.invoke('initial');
  for (const [id, ssh] of [['alpha', first], ['beta', second]]) {
    await backend.invoke('save-profile', profile(ssh, { id })); const watermark = backend.messages.length;
    await backend.invoke('connect', id, { password: 'test-password' }); await backend.trust(id, true, watermark);
    await backend.state(id, state => state.status === 'connected', 'SFTP connection');
  }
  const call = (action, args = {}) => backend.invoke('files', action, args).catch(error => { error.message = `${action}: ${error.message}; backend ${backend.stderr}`; throw error; });
  const job = async (id, predicate, timeout = 40000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const current = (await call('transfers')).find(t => t.id === id); if (current && predicate(current)) return current; await delay(30); }
    throw Error('Transfer did not reach expected state: ' + JSON.stringify(await call('transfers')));
  };
  const done = id => job(id, t => { if (t.status === 'failed') throw Error(t.error); return t.status === 'completed'; });
  const start = async (sourceId, source, targetId, target) => (await call('transfer', { sources: [{ profileId: sourceId, path: source }], target: { profileId: targetId, path: target } }))[0];
  return { call, job, done, start, backend, first, remote, other, local };
}

test('SFTP browse, completions, UTF text editing, safe save and file mutations reuse SSH', { timeout: 60000 }, async t => {
  const f = await fixture(t); const home = path.join(f.remote, 'home/tester');
  await fs.mkdir(path.join(f.remote, 'data1_hdd')); await fs.mkdir(path.join(f.remote, 'data1_ssd'));
  await fs.writeFile(path.join(home, '中文.py'), '\uFEFFprint("hello")\r\n');
  assert.deepEqual(await f.call('complete', { profileId: 'alpha', path: '/data1' }), ['/data1_hdd', '/data1_ssd']);
  assert.equal((await f.call('list', { profileId: 'alpha', path: '.' })).path, '/home/tester');
  const opened = await f.call('read', { profileId: 'alpha', path: '/home/tester/中文.py' });
  assert.equal(opened.encoding, 'utf8bom'); assert.equal(opened.text, 'print("hello")\r\n');
  const saved = await f.call('save', { profileId: 'alpha', path: '/home/tester/中文.py', revision: opened.revision, encoding: opened.encoding, text: 'print("世界")\r\n' });
  assert.equal(await fs.readFile(path.join(home, '中文.py'), 'utf8'), '\uFEFFprint("世界")\r\n');
  await fs.writeFile(path.join(home, '中文.py'), 'external');
  await assert.rejects(f.call('save', { profileId: 'alpha', path: '/home/tester/中文.py', revision: saved.revision, encoding: 'utf8', text: 'overwrite' }), /修改/);
  assert.equal(await fs.readFile(path.join(home, '中文.py'), 'utf8'), 'external');
  await f.call('create', { profileId: 'alpha', path: '/home/tester', name: '新建', directory: true });
  await f.call('create', { profileId: 'alpha', path: '/home/tester/新建', name: "a'$(x).json", directory: false });
  await f.call('rename', { profileId: 'alpha', path: "/home/tester/新建/a'$(x).json", name: 'renamed.json' });
  await assert.rejects(f.call('create', { profileId: 'alpha', path: '/home/tester', name: '../escape', directory: true }), /无效/);
  assert.equal(f.first.stats.authenticated, 1); assert.ok(!f.first.stats.allCommands.some(command => command.includes('renamed.json')));
});

test('text editing accepts 5 MiB UTF-8 and UTF-16 files and rejects larger files without overwriting', { timeout: 120000 }, async t => {
  const f = await fixture(t), home = path.join(f.remote, 'home/tester'), limit = 5 * 1024 * 1024;
  // Control characters require six bytes each in JSON, exceeding the old IPC
  // request cap even though the actual file stays within the editing limit.
  const original = '\u0001'.repeat(limit - 1) + '\n', edited = original.slice(0, -1) + 'x';
  const args = { profileId: 'alpha', path: '/home/tester/limit.txt' };
  await fs.writeFile(path.join(home, 'limit.txt'), original);
  const opened = await f.call('read', args);
  assert.equal(opened.size, limit); assert.equal(opened.text, original);
  const saved = await f.call('save', { ...args, revision: opened.revision, encoding: opened.encoding, text: edited });
  assert.equal(saved.size, limit);
  assert.equal(await fs.readFile(path.join(home, 'limit.txt'), 'utf8'), edited);
  await assert.rejects(f.call('save', { ...args, revision: saved.revision, encoding: 'utf8', text: edited + 'x' }), /5 MiB/);
  assert.equal(await fs.readFile(path.join(home, 'limit.txt'), 'utf8'), edited);
  await fs.writeFile(path.join(home, 'over.txt'), Buffer.alloc(limit + 1, 0x61));
  await assert.rejects(f.call('read', { profileId: 'alpha', path: '/home/tester/over.txt' }), /5 MiB/);

  // A 5 MiB UTF-16 file can exceed 5 MiB when decoded into the UTF-8 request.
  const utf16 = '中'.repeat(limit / 2 - 1), updated = utf16.slice(0, -1) + '文';
  await fs.writeFile(path.join(home, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16, 'utf16le')]));
  const unicodeArgs = { profileId: 'alpha', path: '/home/tester/utf16.txt' };
  const unicode = await f.call('read', unicodeArgs);
  assert.equal(unicode.size, limit); assert.equal(unicode.text, utf16);
  await f.call('save', { ...unicodeArgs, revision: unicode.revision, encoding: unicode.encoding, text: updated });
  assert.equal(await fs.readFile(path.join(home, 'utf16.txt'), 'utf16le'), '\uFEFF' + updated);
  await assert.rejects(f.backend.invoke('save-profile', { name: 'x'.repeat(2 * 1024 * 1024) }), /请求内容过长/);
});

test('recursive upload/download, cross-server copy and same-directory keep-both preserve bytes', { timeout: 90000 }, async t => {
  const f = await fixture(t); const source = path.join(f.local, 'bundle'); await fs.mkdir(path.join(source, 'empty'), { recursive: true });
  const bytes = randomBytes(500000); await fs.writeFile(path.join(source, 'data.bin'), bytes); await fs.writeFile(path.join(source, '.hidden'), 'hidden');
  await f.done(await f.start(null, source, 'alpha', '/home/tester'));
  await f.done(await f.start('alpha', '/home/tester/bundle', 'beta', '/home/tester'));
  assert.equal(hash(await fs.readFile(path.join(f.other, 'home/tester/bundle/data.bin'))), hash(bytes));
  const download = path.join(f.local, 'download'); await fs.mkdir(download);
  await f.done(await f.start('alpha', '/home/tester/bundle', null, download));
  assert.equal(hash(await fs.readFile(path.join(download, 'bundle/data.bin'))), hash(bytes));
  assert.equal((await fs.stat(path.join(download, 'bundle/empty'))).isDirectory(), true);
  const duplicate = await f.start('alpha', '/home/tester/bundle', 'alpha', '/home/tester'); await f.job(duplicate, t => t.status === 'conflict');
  await f.call('control', { id: duplicate, action: 'resolve', decision: 'keep', all: false }); await f.done(duplicate);
  assert.equal(hash(await fs.readFile(path.join(f.remote, 'home/tester/bundle (1)/data.bin'))), hash(bytes));
});

test('moves refuse collisions and descendants; recursive deletion preserves symlink targets', { timeout: 60000 }, async t => {
  const f = await fixture(t), home = path.join(f.remote, 'home/tester');
  await fs.mkdir(path.join(home, 'A/nested'), { recursive: true }); await fs.mkdir(path.join(home, 'B'));
  await fs.writeFile(path.join(home, 'A/move.txt'), 'move bytes');
  await f.call('move', { profileId: 'alpha', path: '/home/tester/A/move.txt', target: '/home/tester/B' });
  await assert.rejects(fs.stat(path.join(home, 'A/move.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(home, 'B/move.txt'), 'utf8'), 'move bytes');
  await fs.writeFile(path.join(home, 'A/move.txt'), 'do not overwrite');
  await assert.rejects(f.call('move', { profileId: 'alpha', path: '/home/tester/A/move.txt', target: '/home/tester/B' }), /已经存在/);
  assert.equal(await fs.readFile(path.join(home, 'B/move.txt'), 'utf8'), 'move bytes');
  await assert.rejects(f.call('move', { profileId: 'alpha', path: '/home/tester/A', target: '/home/tester/A/nested' }), /自身或其子目录/);
  await fs.symlink(path.join(home, 'A'), path.join(home, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.call('move', { profileId: 'alpha', path: '/home/tester/A', target: '/home/tester/alias/nested' }), /自身或其子目录/);
  await f.call('delete', { profileId: 'alpha', path: '/home/tester/alias' });
  assert.equal(await fs.readFile(path.join(home, 'A/move.txt'), 'utf8'), 'do not overwrite');
  await f.call('move', { profileId: 'alpha', path: '/home/tester/A', target: '/home/tester/B' });
  assert.equal((await fs.stat(path.join(home, 'B/A/nested'))).isDirectory(), true);
  await f.call('delete', { profileId: 'alpha', path: '/home/tester/B/A' });
  await assert.rejects(fs.stat(path.join(home, 'B/A')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(home, 'B/move.txt'), 'utf8'), 'move bytes');
  for (const protectedPath of ['/', '/home/tester/..', '/home/tester/.']) await assert.rejects(f.call('delete', { profileId: 'alpha', path: protectedPath }), /无效/);
});

test('pause, reconnect resume and cancellation retain partial bytes without corrupting destinations', { timeout: 120000 }, async t => {
  const f = await fixture(t); const bytes = randomBytes(12 * 1024 * 1024); await fs.writeFile(path.join(f.remote, 'home/tester/large.bin'), bytes);
  const id = await f.start('alpha', '/home/tester/large.bin', null, f.local);
  await f.job(id, t => t.transferred > 262144); await f.call('control', { id, action: 'pause' }); await delay(200);
  const paused = await f.job(id, t => t.status === 'paused'); await delay(300);
  assert.equal((await f.job(id, t => t.status === 'paused')).transferred, paused.transferred);
  await assert.rejects(fs.stat(path.join(f.local, 'large.bin')), { code: 'ENOENT' });
  f.first.disconnectClients(); await f.backend.state('alpha', s => s.status === 'reconnecting', 'disconnected');
  await f.backend.state('alpha', s => s.status === 'connected', 'reconnected');
  await f.call('control', { id, action: 'resume' }); await f.done(id);
  assert.equal(hash(await fs.readFile(path.join(f.local, 'large.bin'))), hash(bytes));
  const next = await f.start('alpha', '/home/tester/large.bin', 'beta', '/home/tester');
  await f.job(next, t => t.transferred > 0); await f.call('control', { id: next, action: 'cancel' }); await f.job(next, t => t.status === 'cancelled');
  assert.deepEqual(await fs.readdir(path.join(f.other, 'home/tester')), []);
});

test('active disconnect resumes, failed writes retry, overwrite is atomic and skipped bytes are not transferred', { timeout: 120000 }, async t => {
  const f = await fixture(t); const bytes = randomBytes(6 * 1024 * 1024);
  await fs.writeFile(path.join(f.remote, 'home/tester/resume.bin'), bytes);
  const id = await f.start('alpha', '/home/tester/resume.bin', null, f.local);
  await f.job(id, task => task.transferred > 262144);
  f.first.disconnectClients();
  await f.backend.state('alpha', state => state.status === 'reconnecting', 'active disconnect');
  await f.job(id, task => task.status === 'waiting');
  await f.done(id);
  assert.equal(hash(await fs.readFile(path.join(f.local, 'resume.bin'))), hash(bytes));

  await fs.writeFile(path.join(f.local, 'retry.bin'), bytes);
  await fs.writeFile(path.join(f.remote, 'home/tester/retry.bin'), 'original');
  f.first.setSftpFailure(true);
  const retry = await f.start(null, path.join(f.local, 'retry.bin'), 'alpha', '/home/tester');
  await f.job(retry, task => task.status === 'conflict');
  await f.call('control', { id: retry, action: 'resolve', decision: 'overwrite' });
  await f.job(retry, task => task.status === 'failed');
  assert.equal(await fs.readFile(path.join(f.remote, 'home/tester/retry.bin'), 'utf8'), 'original');
  f.first.setSftpFailure(false);
  await f.call('control', { id: retry, action: 'retry' }); await f.done(retry);
  assert.equal(hash(await fs.readFile(path.join(f.remote, 'home/tester/retry.bin'))), hash(bytes));
  const skip = await f.start(null, path.join(f.local, 'retry.bin'), 'alpha', '/home/tester');
  await f.job(skip, task => task.status === 'conflict');
  await f.call('control', { id: skip, action: 'resolve', decision: 'skip' });
  const result = await f.done(skip); assert.equal(result.transferred, 0); assert.equal(result.skipped, bytes.length);
});

test('paused transfers release queue slots and every new job is immediately observable', { timeout: 90000 }, async t => {
  const f = await fixture(t), bytes = randomBytes(24 * 1024 * 1024), paused = [];
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(f.remote, `home/tester/paused-${i}.bin`), bytes);
    const id = await f.start('alpha', `/home/tester/paused-${i}.bin`, null, f.local);
    await f.job(id, task => task.transferred > 0); await f.call('control', { id, action: 'pause' }); paused.push(id);
  }
  await fs.writeFile(path.join(f.remote, 'home/tester/next.txt'), 'next');
  const watermark = f.backend.messages.length;
  const next = await f.start('alpha', '/home/tester/next.txt', null, f.local);
  await f.done(next);
  assert.ok(f.backend.messages.slice(watermark).some(message => message.event === 'lion:files' && message.payload.id === next && message.payload.status === 'queued'));
  assert.equal(await fs.readFile(path.join(f.local, 'next.txt'), 'utf8'), 'next');
  for (const id of paused) { await f.call('control', { id, action: 'cancel' }); await f.job(id, task => task.status === 'cancelled'); }
});

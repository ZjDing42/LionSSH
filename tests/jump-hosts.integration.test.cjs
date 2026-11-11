'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ServiceHarness } = require('./helpers/service-harness.cjs');
const { localSshServer, echoServer, freePort, roundTrip } = require('./helpers/local-ssh.cjs');
const { profile, tunnel, delay } = require('./helpers/fixtures.cjs');

async function fixture(t, firstOptions = {}) {
  const root = path.resolve(__dirname, '../test-output');
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'jump-hosts-'));
  const remote = path.join(directory, 'remote');
  await fs.mkdir(path.join(remote, 'home/tester'), { recursive: true });
  await fs.writeFile(path.join(remote, 'home/tester/route.txt'), 'through two hops\n');
  const target = await localSshServer({ password: 'target-password', sftpRoot: remote, terminalEnabled: true });
  const middle = await localSshServer({ password: 'middle-password', allowedForwardPorts: [target.port] });
  const first = await localSshServer({ password: 'first-password', allowedForwardPorts: [middle.port], ...firstOptions });
  let backend = new ServiceHarness(path.join(directory, 'data'));
  await backend.invoke('initial');
  t.after(async () => {
    await backend.stop();
    await Promise.all([first.close(), middle.close(), target.close()]);
    assert.equal(path.dirname(directory), root);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const config = profile(target, { id: 'multi-hop', jumpHosts: [profile(first, { id: 'first', name: 'First hop' }), profile(middle, { id: 'middle', name: 'Middle hop' })] });
  const secrets = { password: 'target-password', remember: true, jumpHosts: { first: { password: 'first-password', remember: true }, middle: { password: 'middle-password', remember: true } } };
  return { config, secrets, first, middle, target, directory, remote, get backend() { return backend; }, async restart() { await backend.stop(); backend = new ServiceHarness(path.join(directory, 'data')); return backend.invoke('initial'); } };
}
async function waitFor(predicate, label, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await delay(30); }
  throw Error('Timed out: ' + label);
}
async function trustAll(backend, id, start, count) {
  let cursor = start;
  const keys = [];
  for (let n = 0; n < count; n++) {
    const event = await backend.waitFor(messages => {
      const failure = messages.slice(cursor).find(m => m.error);
      if (failure) throw Error(failure.error);
      return messages.slice(cursor).find(m => m.event === 'lion:host-key' && m.payload.profileId === id);
    }, 'hop fingerprint');
    cursor = backend.messages.indexOf(event) + 1;
    keys.push(event.payload);
    await backend.invoke('trust-host', id, true, event.payload.fingerprint);
  }
  return keys;
}
const integration = { timeout: 90000 };

test('cancellation arriving before a test request prevents any SSH connection', integration, async t => {
  const f = await fixture(t), probe = 'probe:' + randomUUID();
  await f.backend.invoke('cancel-test-connection', probe);
  await assert.rejects(f.backend.invoke('test-connection', probe, f.config, f.secrets), /连接测试已取消/);
  assert.equal(f.first.stats.connections, 0);
});

test('unsaved hop and target tests authenticate the selected prefix, verify every key and leave no live sessions or saved device', integration, async t => {
  const f = await fixture(t);
  const probe = 'probe:' + randomUUID();
  const start = f.backend.messages.length;
  const result = f.backend.invoke('test-connection', probe, f.config, f.secrets);
  result.catch(() => {});
  const keys = await trustAll(f.backend, probe, start, 3);
  assert.deepEqual(keys.map(k => k.port), [f.first.port, f.middle.port, f.target.port]);
  assert.deepEqual(keys.map(k => k.routeIndex), [0, 1, 2]);
  assert.equal((await result).hops, 2);
  await waitFor(() => [f.first, f.middle, f.target].every(s => s.stats.lifecycle.filter(e => e.type === 'connection-close').length === s.stats.connections), 'all probe connections closed');
  const snapshot = await f.backend.invoke('initial');
  assert.deepEqual(snapshot.profiles, []); assert.deepEqual(snapshot.states, []); assert.deepEqual(snapshot.pendingHostKeys, []);
  for (const server of [f.first, f.middle, f.target]) { assert.deepEqual(server.stats.allCommands, []); assert.deepEqual(server.stats.terminalSessions, []); assert.equal(server.listeners.size, 0); }
  const known = JSON.parse(await fs.readFile(path.join(f.directory, 'data/known-hosts.json')));
  for (const server of [f.first, f.middle, f.target]) assert.deepEqual(known[`127.0.0.1:${server.port}`], [server.fingerprint]);
  const targetConnections = f.target.stats.connections;
  // A hop can be tested while the eventual target and later hop are unfinished.
  const partial = { ...f.config, host: '', username: '', jumpHosts: [f.config.jumpHosts[0], { id: 'unfinished' }] };
  await f.backend.invoke('test-connection', 'probe:' + randomUUID(), partial, f.secrets, 'first');
  assert.equal(f.target.stats.connections, targetConnections);
  assert.equal((await f.backend.invoke('test-connection', 'probe:' + randomUUID(), f.config, f.secrets, 'middle')).hops, 1);
  assert.equal(f.target.stats.connections, targetConnections);
});

test('remembered credentials survive restart, stay attached to hop IDs when reordered, and are removed with their hop', integration, async t => {
  const f = await fixture(t);
  let saved = await f.backend.invoke('save-profile', f.config, f.secrets);
  assert.equal(saved.hasSavedSecret, true); assert.ok(saved.jumpHosts.every(h => h.hasSavedSecret));
  const raw = await fs.readFile(path.join(f.directory, 'data/credentials.json'), 'utf8');
  for (const secret of ['first-password', 'middle-password', 'target-password']) assert.ok(!raw.includes(secret));
  saved.jumpHosts.reverse();
  await f.backend.invoke('save-profile', saved);
  let snapshot = await f.restart();
  assert.deepEqual(snapshot.profiles[0].jumpHosts.map(h => h.id), ['middle', 'first']);
  assert.ok(snapshot.profiles[0].jumpHosts.every(h => h.hasSavedSecret));
  saved.jumpHosts.reverse();
  await f.backend.invoke('save-profile', saved);
  const probe = 'probe:' + randomUUID(), start = f.backend.messages.length;
  const result = f.backend.invoke('test-connection', probe, saved);
  result.catch(() => {});
  await trustAll(f.backend, probe, start, 3); assert.equal((await result).ok, true);
  saved.jumpHosts = [saved.jumpHosts[0]];
  await f.backend.invoke('save-profile', saved);
  saved.jumpHosts = f.config.jumpHosts;
  saved = await f.backend.invoke('save-profile', saved);
  assert.equal(saved.jumpHosts[0].hasSavedSecret, true); assert.equal(saved.jumpHosts[1].hasSavedSecret, false);
  saved.jumpHosts = [];
  await f.backend.invoke('save-profile', saved);
  snapshot = await f.restart();
  assert.deepEqual(snapshot.profiles[0].jumpHosts, []);
});

test('session-only passwords survive reordering and blank edits but are never reused for changed login identities', integration, async t => {
  const f = await fixture(t);
  f.secrets.remember = false;
  for (const secret of Object.values(f.secrets.jumpHosts)) secret.remember = false;
  let saved = await f.backend.invoke('save-profile', f.config, f.secrets);
  const blank = { remember: false, jumpHosts: { first: { remember: false }, middle: { remember: false } } };
  saved.jumpHosts.reverse();
  await f.backend.invoke('save-profile', saved, blank);
  saved.jumpHosts.reverse();
  await f.backend.invoke('save-profile', saved, blank);
  const probe = 'probe:' + randomUUID(), start = f.backend.messages.length;
  const result = f.backend.invoke('test-connection', probe, saved);
  result.catch(() => {});
  await trustAll(f.backend, probe, start, 3);
  assert.equal((await result).ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, 'data/credentials.json'))), {});
  saved.jumpHosts[0].username = 'different-user';
  saved = await f.backend.invoke('save-profile', saved, blank);
  await assert.rejects(f.backend.invoke('test-connection', 'probe:' + randomUUID(), saved), /跳板机 1.*请先输入 SSH 密码/);
});

test('multi-hop password/key route carries terminal, SFTP, GPU and both tunnel directions, reconnecting after a hop drops', integration, async t => {
  const f = await fixture(t);
  const echo = await echoServer(); t.after(() => echo.close());
  const local = await freePort(), remote = await freePort();
  f.config.jumpHosts[1].authType = 'key'; f.config.jumpHosts[1].keyPath = f.middle.keyPath;
  f.config.tunnels = [tunnel('forward', local, echo.port), tunnel('reverse', remote, echo.port, 'remote')];
  f.config.gpu.enabled = true;
  await f.backend.invoke('save-profile', f.config, f.secrets);
  const start = f.backend.messages.length;
  await f.backend.invoke('connect', f.config.id);
  await trustAll(f.backend, f.config.id, start, 3);
  await f.backend.state(f.config.id, s => s.status === 'connected' && s.gpu.status === 'ready' && s.tunnels.length === 2 && s.tunnels.every(t => t.status === 'running'), 'multi-hop ready');
  assert.equal(await roundTrip(local, 'forward through hops'), 'forward through hops');
  assert.equal(await roundTrip(remote, 'reverse through hops'), 'reverse through hops');
  const file = await f.backend.invoke('files', 'read', { profileId: f.config.id, path: '/home/tester/route.txt' });
  assert.equal(file.text, 'through two hops\n');
  await f.backend.invoke('files', 'save', { profileId: f.config.id, path: '/home/tester/route.txt', text: 'saved via hops', revision: file.revision, encoding: 'utf8' });
  assert.equal(await fs.readFile(path.join(f.remote, 'home/tester/route.txt'), 'utf8'), 'saved via hops');
  await f.backend.invoke('terminal-open', f.config.id, 80, 24);
  assert.equal(f.target.stats.terminalSessions.length, 1);
  assert.ok(f.middle.stats.authenticationMethods.includes('publickey'));
  assert.deepEqual(f.first.stats.allCommands, []); assert.deepEqual(f.middle.stats.allCommands, []);
  assert.equal(f.first.listeners.size, 0); assert.equal(f.middle.listeners.size, 0); assert.equal(f.target.listeners.size, 1);
  const connections = f.target.stats.connections;
  // A probe must not replace this working connection or terminal.
  assert.equal((await f.backend.invoke('test-connection', 'probe:' + randomUUID(), f.config)).ok, true);
  assert.equal((await f.backend.invoke('terminal-list', f.config.id))[0].status, 'running');
  assert.equal(await roundTrip(local, 'still connected'), 'still connected');
  f.first.disconnectClients();
  await waitFor(() => f.target.stats.connections > connections + 1, 'route re-established');
  await f.backend.state(f.config.id, s => s.status === 'connected' && s.tunnels.every(t => t.status === 'running'), 'reconnected route');
  assert.equal(await roundTrip(local, 'restored'), 'restored');
  assert.equal((await f.backend.invoke('files', 'read', { profileId: f.config.id, path: '/home/tester/route.txt' })).text, 'saved via hops');
  await f.backend.invoke('disconnect', f.config.id);
  await waitFor(() => [f.first, f.middle, f.target].every(s => s.stats.lifecycle.filter(e => e.type === 'connection-close').length === s.stats.connections), 'all route connections closed');
});

test('failed intermediate authentication and cancelled fingerprint prompts close the entire partial route', integration, async t => {
  const f = await fixture(t);
  const secrets = structuredClone(f.secrets); secrets.jumpHosts.middle.password = 'wrong';
  let id = 'probe:' + randomUUID(), start = f.backend.messages.length;
  let result = f.backend.invoke('test-connection', id, f.config, secrets); result.catch(() => {});
  await trustAll(f.backend, id, start, 2);
  await assert.rejects(result, /跳板机 2.*认证失败/);
  assert.equal(f.target.stats.connections, 0);
  await waitFor(() => f.first.stats.lifecycle.filter(e => e.type === 'connection-close').length === f.first.stats.connections, 'failed route closed');
  // The target is still unknown, so cancel its pending fingerprint prompt.
  id = 'probe:' + randomUUID(); start = f.backend.messages.length;
  result = f.backend.invoke('test-connection', id, f.config, f.secrets); result.catch(() => {});
  await f.backend.waitFor(messages => messages.slice(start).find(m => m.event === 'lion:host-key' && m.payload.profileId === id), 'target key prompt');
  await f.backend.invoke('cancel-test-connection', id);
  await assert.rejects(result, /已取消/);
  await waitFor(() => [f.first, f.middle, f.target].every(s => s.stats.lifecycle.filter(e => e.type === 'connection-close').length === s.stats.connections), 'cancelled route closed');
  assert.deepEqual((await f.backend.invoke('initial')).pendingHostKeys, []);
});

test('denied forwarding identifies the failing next hop and does not fall back to a direct connection', integration, async t => {
  const f = await fixture(t, { disableDirectForwarding: true });
  const id = 'probe:' + randomUUID(), start = f.backend.messages.length;
  const result = f.backend.invoke('test-connection', id, f.config, f.secrets); result.catch(() => {});
  await trustAll(f.backend, id, start, 1);
  await assert.rejects(result, /跳板机 2.*转发/);
  assert.equal(f.middle.stats.connections, 0); assert.equal(f.target.stats.connections, 0);
  await waitFor(() => f.first.stats.lifecycle.filter(e => e.type === 'connection-close').length === f.first.stats.connections, 'denied route closed');
});

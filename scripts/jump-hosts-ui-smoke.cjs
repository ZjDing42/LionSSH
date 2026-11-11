'use strict';
// Headless renderer checks with an in-memory API; no real SSH or user data.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1382, height: 952 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      let onHostKey = () => {}, onTheme = () => {}, onLanguage = () => {};
      const clone = value => JSON.parse(JSON.stringify(value));
      const mock = window.mock = { calls: [], mode: 'success', saved: null, pending: null };
      window.lion = {
        getInitial: async () => ({ profiles: [], states: [], pendingHostKeys: [], version: '1.11.0', theme: { preference: 'dark', resolved: 'dark' }, language: { preference: 'zh', resolved: 'zh' } }),
        getUpdateState: async () => ({ status: 'idle', configured: false, currentVersion: '1.11.0' }),
        onState: () => () => {}, onShutdown: () => () => {}, onBackendError: () => () => {}, onUpdate: () => () => {},
        onHostKey: callback => { onHostKey = callback; return () => {}; },
        onTheme: callback => { onTheme = callback; return () => {}; },
        onLanguage: callback => { onLanguage = callback; return () => {}; },
        setTheme: async preference => { const result = { preference, resolved: preference }; onTheme(result); return result; },
        setLanguage: async preference => { const result = { preference, resolved: preference }; onLanguage(result); return result; },
        pickKey: async () => 'C:\\fixture\\id_ed25519',
        saveProfile: async (profile, secrets) => {
          mock.calls.push({ method: 'save', profile: clone(profile), secrets: clone(secrets) });
          const result = clone(profile); result.hasSavedSecret = !!secrets.remember;
          for (const hop of result.jumpHosts) hop.hasSavedSecret = !!secrets.jumpHosts[hop.id]?.remember;
          mock.saved = result; return result;
        },
        testConnection: async (id, profile, secrets, through) => {
          mock.calls.push({ method: 'test', id, profile: clone(profile), secrets: clone(secrets), through });
          if (mock.mode === 'error') throw Error('跳板机 2（hop-two:22）：SSH 认证失败');
          if (mock.mode === 'success') return { ok: true, hops: profile.jumpHosts.length };
          return new Promise((resolve, reject) => {
            const endpoints = [...profile.jumpHosts, profile];
            const pending = mock.pending = { id, resolve, reject, index: 0, emit: () => {
              const endpoint = endpoints[pending.index];
              onHostKey({ profileId: id, host: endpoint.host, port: endpoint.port, fingerprint: 'SHA256:identical-test-key', keyType: 'ssh-ed25519', changed: false, connectionTest: true, routeIndex: pending.index, endpointName: endpoint.name, isJumpHost: pending.index < endpoints.length - 1 });
            } };
            if (mock.mode === 'trust') pending.emit();
          });
        },
        trustHost: async (id, accepted) => {
          assertPending();
          if (!accepted) { mock.pending.reject(Error('已拒绝服务器指纹')); return; }
          if (++mock.pending.index === 3) { mock.pending.resolve({ ok: true }); mock.pending = null; }
          else mock.pending.emit(); // Next hop arrives BEFORE this promise resolves.
        },
        cancelTestConnection: async id => { mock.calls.push({ method: 'cancel', id }); mock.pending?.reject(Error('连接测试已取消')); mock.pending = null; },
      };
      function assertPending() { if (!mock.pending) throw Error('Missing probe'); }
    });
    await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
    await page.getByTestId('add-device').click();
    assert.equal(await page.locator('.brand small').count(), 0);
    assert.equal(await page.getByText('DEVICE SETTINGS', { exact: true }).count(), 0);
    const cards = page.locator('.jump-card');
    for (const name of ['hop-one', 'hop-two']) {
      await page.getByTestId('add-jump-host').click();
      const card = cards.last();
      await card.locator('.field input').first().fill(name);
      await card.getByPlaceholder('IP 地址或主机名').fill(name);
      await card.getByLabel('用户名', { exact: true }).fill('tester');
      if (name === 'hop-one') {
        await card.getByRole('button', { name: '密码', exact: true }).click();
        await card.getByLabel('连接密码', { exact: true }).fill('first-password');
        await card.getByRole('checkbox').check();
        await card.getByRole('button', { name: '测试连接', exact: true }).click();
        await card.getByText('连接成功，SSH 登录已验证。', { exact: true }).waitFor();
      } else {
        await card.getByRole('button', { name: '选择私钥文件' }).click();
        assert.equal(await card.getByPlaceholder('选择本机私钥文件').inputValue(), 'C:\\fixture\\id_ed25519');
      }
    }
    const ids = await cards.evaluateAll(elements => elements.map(e => e.dataset.hopId));
    await cards.last().getByRole('button', { name: '上移', exact: true }).click();
    assert.deepEqual(await cards.evaluateAll(elements => elements.map(e => e.dataset.hopId)), [...ids].reverse());
    await cards.first().getByRole('button', { name: '下移', exact: true }).click();
    const target = page.locator('.connection-fields');
    await target.getByPlaceholder('例如：训练服务器').fill('多级跳转测试');
    await target.getByPlaceholder('IP 地址或主机名').fill('target.internal');
    await target.getByPlaceholder('例如：user').fill('tester');
    await target.getByRole('button', { name: '密码', exact: true }).click();
    await target.getByPlaceholder('可稍后在连接时输入').fill('target-password');
    await page.evaluate(() => window.mock.mode = 'trust');
    await page.getByTestId('test-target-connection').click();
    for (const host of ['hop-one', 'hop-two', 'target.internal']) {
      await page.locator('.host-modal .fingerprint-box > span').filter({ hasText: `${host}:22` }).waitFor();
      await page.getByTestId('host-accept').click();
    }
    await page.locator('.host-modal').waitFor({ state: 'hidden' });
    await page.locator('.form-body > .connection-test-result').getByText('连接成功，SSH 登录已验证。', { exact: true }).waitFor();
    const call = await page.evaluate(() => window.mock.calls.filter(c => c.method === 'test').at(-1));
    assert.deepEqual(call.profile.jumpHosts.map(h => h.id), ids);
    assert.equal(call.secrets.jumpHosts[ids[0]].password, 'first-password');
    assert.equal(call.secrets.password, 'target-password');
    await page.evaluate(() => window.mock.mode = 'error');
    await page.getByTestId('test-target-connection').click();
    await page.locator('.form-body > .connection-test-result.error').waitFor();
    await page.evaluate(() => window.mock.mode = 'hold');
    await page.getByTestId('test-target-connection').click();
    assert.equal(await target.getByPlaceholder('例如：训练服务器').isDisabled(), true);
    assert.equal(await page.getByTestId('device-save').isDisabled(), true);
    await page.getByRole('button', { name: '取消测试', exact: true }).click();
    assert.equal(await page.getByTestId('device-save').isEnabled(), true);
    await cards.first().locator('.jump-toggle').click();
    await cards.last().locator('.jump-toggle').click();
    await fs.mkdir('test-output', { recursive: true });
    await page.locator('.form-body').evaluate(e => e.scrollTop = 0);
    await page.screenshot({ path: 'test-output/jump-hosts-dark.png' });
    await page.getByTestId('device-save').click();
    await page.locator('.drawer').waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => window.mock.saved);
    assert.deepEqual(saved.jumpHosts.map(h => h.id), ids);
    assert.equal(saved.jumpHosts[0].hasSavedSecret, true);
    // Reopening retains the chain and hasSavedSecret flags without revealing a password.
    await page.getByRole('button', { name: '编辑设备', exact: true }).click();
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.first().getByRole('checkbox').isChecked(), true);
    assert.equal(await cards.first().getByLabel('连接密码', { exact: true }).inputValue(), '');
    await page.evaluate(() => window.lion.setLanguage('en'));
    await page.getByRole('button', { name: 'Add jump host', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Test connection', exact: true }).count(), 3);
    await page.evaluate(() => window.lion.setTheme('light'));
    await cards.first().locator('.jump-toggle').click();
    await cards.last().locator('.jump-toggle').click();
    await page.screenshot({ path: 'test-output/jump-hosts-light.png' });
    for (let i = 0; i < 2; i++) await cards.first().getByRole('button', { name: 'Remove jump host', exact: true }).click();
    assert.equal(await cards.count(), 0);
    await page.getByTestId('device-save').click();
    await page.locator('.drawer').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.evaluate(() => window.mock.saved.jumpHosts), []);
    assert.deepEqual(errors, []);
    console.log('Jump host UI passed: add/reorder/remove, credential identity, prefix/target tests, sequential trust, cancel, save/reopen, dark/light and Chinese/English.');
  } catch (error) {
    await page.screenshot({ path: 'test-output/jump-hosts-ui-failure.png' });
    console.error((await page.locator('body').innerText()).slice(-5000));
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

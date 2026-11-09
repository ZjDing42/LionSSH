'use strict';
// Isolated native SFTP fixture for manual OS drag/drop verification. Never loads user profiles.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { localSshServer, freePort } = require('../tests/helpers/local-ssh.cjs');
const { profile, delay } = require('../tests/helpers/fixtures.cjs');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'test-output');
const executable = path.join(root, 'release', `Lion-SSH-${require('../package.json').version}-windows-${process.arch}-portable`, 'Lion SSH.exe');
(async () => {
  await fs.mkdir(output, { recursive: true });
  const directory = await fs.mkdtemp(path.join(output, 'files-native-'));
  const remote = path.join(directory, 'remote'), downloads = path.join(directory, 'downloads'), uploads = path.join(directory, 'uploads');
  const data = path.join(directory, 'data');
  await Promise.all([path.join(remote, 'home/tester/bundle/empty'), downloads, uploads, data].map(p => fs.mkdir(p, { recursive: true })));
  await fs.writeFile(path.join(remote, 'home/tester/drag.txt'), 'Native SFTP drag download\n');
  await fs.writeFile(path.join(remote, 'home/tester/bundle/中文.py'), 'print("native folder download")\n');
  await fs.writeFile(path.join(uploads, 'upload.txt'), 'Native SFTP drag upload\n');
  await fs.mkdir(path.join(uploads, 'upload-folder/empty'), { recursive: true });
  await fs.writeFile(path.join(uploads, 'upload-folder/中文.txt'), 'Native folder upload\n');
  await fs.mkdir(path.join(remote, 'home/tester/A/subfolder'), { recursive: true });
  await fs.mkdir(path.join(remote, 'home/tester/B'), { recursive: true });
  await fs.writeFile(path.join(remote, 'home/tester/A/move.txt'), 'Move this file into B\n');
  await fs.writeFile(path.join(remote, 'home/tester/A/subfolder/child.txt'), 'Move this folder into B\n');
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'dark', language: 'zh-CN' }));
  const ssh = await localSshServer({ sftpRoot: remote, sftpReadDelay: 5 });
  await fs.writeFile(path.join(data, 'profiles.json'), JSON.stringify([profile(ssh, { id: 'files-native', name: 'SFTP 拖放测试（本地）' })]));
  const runtimeExe = path.join(directory, 'Lion SSH.exe'); await fs.copyFile(executable, runtimeExe);
  const port = await freePort(); let browser, app, log = '', stopping = false, exited = false;
  const stopFile = path.join(directory, 'stop');
  try {
    app = spawn(runtimeExe, ['--verification-instance'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LION_DATA_DIR: data, LION_VERIFY_ROOT: directory, LION_VERIFY_INSTANCE_ID: randomUUID(), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` } });
    app.once('exit', () => { exited = true; });
    app.on('error', error => { log += error.message; });
    app.stdout.on('data', b => { log += b; }); app.stderr.on('data', b => { log += b; });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !browser) {
      if (exited) throw Error(`Native app exited: ${log}`);
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1200 }); } catch { await delay(250); }
    }
    assert.ok(browser, `Native app failed to start: ${log}`);
    let page;
    while (Date.now() < deadline && !page) { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() !== 'about:blank'); if (!page) await delay(100); }
    assert.ok(page);
    await page.locator('.app-shell').waitFor({ timeout: 20000 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const invoke = (method, ...args) => page.evaluate(({ method, args }) => window.__TAURI_INTERNALS__.invoke('lion_request', { method, args }), { method, args });
    await invoke('connect', 'files-native', { password: 'test-password' });
    const trustDeadline = Date.now() + 15000;
    while (Date.now() < trustDeadline) {
      if (await page.getByTestId('host-accept').isVisible().catch(() => false)) { await page.getByTestId('host-accept').click(); break; }
      await delay(100);
    }
    const connectedDeadline = Date.now() + 15000;
    while (Date.now() < connectedDeadline) { const state = (await invoke('initial')).states.find(s => s.profileId === 'files-native'); if (state?.status === 'connected') break; await delay(100); }
    await page.getByTestId('tool-files').click();
    await page.locator('[data-file-path="/home/tester/drag.txt"]').waitFor({ timeout: 15000 });
    await fs.writeFile(path.join(output, 'files-native-session.json'), JSON.stringify({ pid: app.pid, port, directory, remote, downloads, uploads, stopFile }, null, 2));
    console.log(`Native SFTP fixture ready: ${directory}`);
    if (process.argv.includes('--hold')) {
      const stop = () => { stopping = true; }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
      while (!stopping && !exited && !(await fs.stat(stopFile).catch(() => null))) await delay(500);
      const downloaded = await fs.readFile(path.join(downloads, 'drag.txt')).catch(() => null);
      const uploaded = await fs.readFile(path.join(remote, 'home/tester/upload.txt')).catch(() => null);
      const folder = await fs.readFile(path.join(downloads, 'bundle/中文.py')).catch(() => null);
      const result = { downloaded: downloaded?.toString() === 'Native SFTP drag download\n', uploaded: uploaded?.toString() === 'Native SFTP drag upload\n', folderDownloaded: folder?.toString() === 'print("native folder download")\n', emptyFolder: Boolean(await fs.stat(path.join(downloads, 'bundle/empty')).catch(() => null)), errors };
      if (downloaded) result.sha256 = createHash('sha256').update(downloaded).digest('hex');
      await fs.writeFile(path.join(output, 'files-native-result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close().catch(() => {});
    if (app && !exited) app.kill();
    await ssh.close();
    // Preserve the isolated fixture and report so the observed OS output remains inspectable.
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

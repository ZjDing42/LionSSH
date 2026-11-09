'use strict';
// Real backend + loopback SFTP, with native file pickers replaced by explicit fixture paths.
const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ServiceHarness } = require('../tests/helpers/service-harness.cjs');
const { localSshServer } = require('../tests/helpers/local-ssh.cjs');
const { profile } = require('../tests/helpers/fixtures.cjs');
const { verifyFileEditor } = require('../tests/helpers/file-editor.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const output = path.join(root, 'test-output'); await fs.mkdir(output, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(output, 'files-ui-'));
  const remote = path.join(fixture, 'remote'), local = path.join(fixture, 'local');
  await fs.mkdir(path.join(remote, 'home/tester/src/deep'), { recursive: true }); await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'upload.txt'), 'drag upload fixture');
  await fs.mkdir(path.join(local, 'upload-folder/empty'), { recursive: true });
  await fs.writeFile(path.join(local, 'upload-folder/nested.txt'), 'folder upload fixture');
  for (const name of ['data1_hdd', 'data1_ssd']) await fs.mkdir(path.join(remote, name));
  await fs.writeFile(path.join(remote, 'home/tester/train.py'), '# Lion SSH\r\nimport json\r\nprint("hello")\r\n');
  await fs.writeFile(path.join(remote, 'home/tester/config.json'), '{"epochs": 12}\n');
  await fs.writeFile(path.join(remote, 'home/tester/.env.example'), 'PORT=8000\n');
  await fs.writeFile(path.join(remote, 'home/tester/image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8i8AAAAASUVORK5CYII=', 'base64'));
  const ssh = await localSshServer({ sftpRoot: remote }); const backend = new ServiceHarness(path.join(fixture, 'data'));
  let browser, events;
  try {
    await backend.invoke('initial');
    // The real backend resolves system language independently of Chromium's locale.
    await backend.invoke('set-language', 'zh');
    for (const id of ['alpha', 'beta']) {
      await backend.invoke('save-profile', profile(ssh, { id, name: id === 'alpha' ? '研究服务器' : '计算服务器' }));
      const cursor = backend.messages.length; await backend.invoke('connect', id, { password: 'test-password' }); if (id === 'alpha') await backend.trust(id, true, cursor);
      await backend.state(id, s => s.status === 'connected');
    }
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1450, height: 980 }, locale: 'zh-CN' }); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const config = JSON.parse(await fs.readFile(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    await page.route('https://lion-files.test/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve(root, 'dist', '.' + (pathname === '/' ? '/index.html' : pathname));
      assert.ok(file.startsWith(path.join(root, 'dist') + path.sep));
      await route.fulfill({ body: await fs.readFile(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', headers: { 'Content-Security-Policy': config.app.security.csp } });
    });
    await page.exposeFunction('nativeInvoke', (method, args) => backend.invoke(method, ...args));
    await page.addInitScript(({ local }) => {
      const listeners = {};
      window.fileFixture = { calls: [], local, emit: (event, value) => listeners[event]?.(value) };
      const invoke = (method, ...args) => window.nativeInvoke(method, args);
      window.lion = {
        getInitial: () => invoke('initial'), fileRequest: (action, args) => { window.fileFixture.calls.push({ action, args }); return invoke('files', action, args); },
        fileDialog: async kind => { window.fileFixture.calls.push({ action: 'dialog', kind }); return [kind === 'upload-folder' ? local + '/upload-folder' : kind === 'upload-files' ? local + '/upload.txt' : local]; },
        setFileDropRegion: async region => { window.fileFixture.region = region; },
        dragFiles: sources => { window.fileFixture.calls.push({ action: 'native-drag', args: { sources } }); return new Promise(resolve => { window.fileFixture.finishDrag = resolve; }); },
        onFiles: callback => { listeners.files = callback; return () => {}; }, onFileDrop: callback => { listeners.drop = callback; return () => {}; },
        onState: callback => { listeners.state = callback; return () => {}; }, onHostKey: () => () => {}, onShutdown: () => () => {},
        onTheme: callback => { listeners.theme = callback; return () => {}; }, onLanguage: callback => { listeners.language = callback; return () => {}; },
        setTheme: value => invoke('set-theme', value), setLanguage: value => invoke('set-language', value),
      };
    }, { local });
    let cursor = backend.messages.length;
    events = setInterval(() => {
      for (const message of backend.messages.slice(cursor)) {
        const name = ({ 'lion:files': 'files', 'lion:state': 'state', 'lion:theme': 'theme', 'lion:language': 'language' })[message.event];
        if (name) void page.evaluate(({ name, value }) => window.fileFixture.emit(name, value), { name, value: message.payload }).catch(() => {});
      }
      cursor = backend.messages.length;
    }, 40);
    await page.goto('https://lion-files.test');
    assert.deepEqual(await page.locator('.tools-grid .tool-entry').evaluateAll(es => es.map(e => e.dataset.testid)), ['tool-codex', 'tool-terminal', 'tool-files']);
    await page.getByTestId('tool-files').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="files-path"]')?.value === '/home/tester');
    await page.getByTestId('files-path').fill('/data1');
    await page.getByRole('option', { name: '/data1_ssd', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="files-path"]')?.value === '/data1_ssd');
    await page.getByTestId('files-path').fill('/home/tester'); await page.getByTestId('files-path').press('Enter');
    const srcFolder = page.locator('[data-file-path="/home/tester/src"]');
    assert.equal(await srcFolder.getByRole('button', { name: '进入目录', exact: true }).count(), 0);
    await srcFolder.click(); assert.equal(await srcFolder.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByTestId('files-path').inputValue(), '/home/tester');
    await srcFolder.click(); assert.equal(await srcFolder.getAttribute('aria-expanded'), 'false');
    await srcFolder.dblclick();
    assert.equal(await page.getByTestId('files-path').inputValue(), '/home/tester');
    assert.equal(await srcFolder.getAttribute('aria-expanded'), 'true');
    await srcFolder.getByRole('button', { name: '进入目录', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="files-path"]')?.value === '/home/tester/src');
    await page.getByRole('button', { name: '上级目录', exact: true }).click();
    await srcFolder.waitFor();
    // External writers do not emit app transfer events. Every refresh entry
    // point must reload expanded descendants, not just the root listing.
    const deepFolder = page.locator('[data-file-path="/home/tester/src/deep"]');
    await deepFolder.click();
    const fileRow = name => page.locator(`[data-file-path="/home/tester/${name}"]`);
    const external = async name => fs.writeFile(path.join(remote, 'home/tester', name), 'external writer\n');
    for (const name of ['external-root.txt', 'src/external-child.txt', 'src/deep/external-deep.txt']) await external(name);
    await page.locator('.files-tree-footer .icon-button').click();
    for (const name of ['external-root.txt', 'src/external-child.txt', 'src/deep/external-deep.txt']) await fileRow(name).waitFor({ timeout: 6000 });
    assert.equal(await srcFolder.getAttribute('aria-expanded'), 'true');
    assert.equal(await deepFolder.getAttribute('aria-expanded'), 'true');
    await external('src/deep/from-menu.txt');
    await deepFolder.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^刷新/ }).click();
    await fileRow('src/deep/from-menu.txt').waitFor({ timeout: 6000 });
    await fs.rename(path.join(remote, 'home/tester/src/external-child.txt'), path.join(remote, 'home/tester/src/renamed-externally.txt'));
    await fs.unlink(path.join(remote, 'home/tester/src/deep/external-deep.txt'));
    await page.locator('.files-tree').focus(); await page.keyboard.press('F5');
    await fileRow('src/renamed-externally.txt').waitFor({ timeout: 6000 });
    await fileRow('src/external-child.txt').waitFor({ state: 'detached' });
    await fileRow('src/deep/external-deep.txt').waitFor({ state: 'detached' });
    await srcFolder.click();
    await external('src/deep/while-collapsed.txt');
    await external('collapsed-refresh.txt');
    await page.locator('.files-tree-footer .icon-button').click();
    await fileRow('collapsed-refresh.txt').waitFor();
    await srcFolder.click();
    await fileRow('src/deep/while-collapsed.txt').waitFor({ timeout: 6000 });
    assert.equal(await deepFolder.getAttribute('aria-expanded'), 'true');
    const train = page.locator('[data-file-path="/home/tester/train.py"]'); await train.click();
    assert.equal(await page.locator('.files-enter').count(), 0);
    const editor = page.locator('.files-pane:visible .cm-content'); await editor.waitFor();
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('print(42)');
    await external('src/deep/while-editing.txt');
    await page.locator('.files-tree-footer .icon-button').click();
    await fileRow('src/deep/while-editing.txt').waitFor();
    assert.equal(await train.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.files-tab.active .files-dirty').count(), 1);
    assert.ok((await editor.innerText()).includes('print(42)'));
    await editor.focus(); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.querySelector('.files-dirty'));
    assert.match(await fs.readFile(path.join(remote, 'home/tester/train.py'), 'utf8'), /print\(42\)/);
    await page.locator('[data-file-path="/home/tester/config.json"]').click();
    assert.equal(await page.getByRole('tab').count(), 2);
    await verifyFileEditor(page, output);
    await page.getByTestId('files-file-plus').click();
    const name = page.getByRole('textbox', { name: '名称', exact: true }); await name.fill('new.py'); await name.press('Enter');
    await page.locator('[data-file-path="/home/tester/new.py"]').waitFor();
    await page.getByTestId('files-edit').click(); await name.fill('renamed.py'); await name.press('Enter');
    await page.locator('[data-file-path="/home/tester/renamed.py"]').waitFor();
    await train.click(); await page.getByTestId('files-copy').click();
    await page.locator('.server-item').filter({ hasText: '计算服务器' }).click();
    await page.waitForFunction(() => document.querySelector('.files-status-end')?.textContent.includes('计算服务器'));
    await page.getByTestId('files-paste').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="file-transfers"]')?.textContent.includes('同名文件'));
    await page.locator('[data-transfer-id]').last().click({ button: 'right' }); await page.getByRole('menuitem', { name: '保留两份', exact: true }).click();
    await page.locator('[data-file-path="/home/tester/train (1).py"]').waitFor();
    await page.locator('[data-file-path="/home/tester/image.png"]').click();
    await page.locator('.files-pane:visible img').waitFor();
    assert.equal(await page.locator('.files-pane:visible .cm-editor').count(), 0);
    const image = page.locator('.files-pane:visible img'), imageWidth = (await image.boundingBox()).width;
    const viewportWidth = await page.evaluate(() => innerWidth);
    await image.hover(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.files-zoom')?.textContent === '125%');
    assert((await image.boundingBox()).width > imageWidth, 'Ctrl+wheel enlarges the image');
    assert.equal(await page.evaluate(() => innerWidth), viewportWidth, 'image zoom does not zoom the app');
    const unmodifiedWheel = await page.locator('.files-image:visible').evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 })));
    assert.equal(unmodifiedWheel, true, 'ordinary wheel scrolling stays available');
    assert.equal(await page.locator('.files-zoom').innerText(), '125%');
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 100); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('.files-zoom')?.textContent === '100%');
    await page.locator('[data-file-path="/home/tester/config.json"]').click();
    await page.getByTestId('files-download').click();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-transfer-id]')].some(row => row.textContent.includes('config.json') && row.textContent.includes('已完成')));
    assert.equal(await fs.readFile(path.join(local, 'config.json'), 'utf8'), '{"epochs": 12}\n');
    await page.locator('[data-file-path="/home/tester/train.py"]').click();
    await page.getByTestId('theme-dark').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: path.join(output, 'files-workspace-dark.png'), fullPage: true });
    await page.evaluate(() => window.lion.setTheme('light'));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.screenshot({ path: path.join(output, 'files-workspace-light.png'), fullPage: true });
    await editor.click(); await page.keyboard.type('# unsaved');
    await page.locator('.files-tab.active button').click(); await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name: '不保存', exact: true }).click();
    await page.locator('[data-file-path="/home/tester/src"]').click();
    const folder = await page.locator('[data-file-path="/home/tester/src"]').boundingBox();
    await page.evaluate(({ x, y }) => window.fileFixture.emit('drop', { type: 'over', x, y, logical: true }), { x: folder.x + 45, y: folder.y + 15 });
    assert.match(await page.locator('[data-file-path="/home/tester/src"]').getAttribute('class'), /drop-active/);
    await page.evaluate(({ x, y }) => window.fileFixture.emit('drop', { type: 'drop', paths: [window.fileFixture.local + '/upload.txt'], x, y, logical: true }), { x: folder.x + 45, y: folder.y + 15 });
    await page.locator('[data-file-path="/home/tester/src/upload.txt"]').waitFor();
    assert.equal(await fs.readFile(path.join(remote, 'home/tester/src/upload.txt'), 'utf8'), 'drag upload fixture');
    const blank = async () => { const box = await page.locator('.files-tree').boundingBox(); await page.mouse.click(box.x + 15, box.y + box.height - 15); };
    await blank(); assert.equal(await page.locator('.files-row.selected').count(), 0);
    await page.getByTestId('files-file-plus').click(); await blank(); assert.equal(await name.count(), 0);
    await page.getByTestId('files-folder-plus').click(); await name.fill('from-blank'); await blank();
    await page.locator('[data-file-path="/home/tester/from-blank"]').waitFor();
    await page.waitForFunction(() => !document.querySelector('.files-row.selected'));
    await page.getByTestId('files-upload').click(); await page.getByRole('menuitem', { name: '上传文件夹…', exact: true }).click();
    await page.locator('[data-file-path="/home/tester/upload-folder"]').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-transfer-id]')].some(row => row.textContent.includes('upload-folder') && row.textContent.includes('已完成')));
    assert.equal(await fs.readFile(path.join(remote, 'home/tester/upload-folder/nested.txt'), 'utf8'), 'folder upload fixture');
    assert.equal((await fs.stat(path.join(remote, 'home/tester/upload-folder/empty'))).isDirectory(), true);
    // Drops outside the tree never enqueue transfers, including the editor.
    const transfersBefore = await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'transfer').length);
    await page.evaluate(() => window.fileFixture.emit('drop', { type: 'drop', paths: [window.fileFixture.local + '/upload.txt'], x: innerWidth - 40, y: 400, logical: true }));
    assert.equal(await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'transfer').length), transfersBefore);
    const moveIntoSrc = async () => { const row = await train.boundingBox(), target = await page.locator('[data-file-path="/home/tester/src"]').boundingBox(); await page.mouse.move(row.x + 55, row.y + 15); await page.mouse.down(); await page.mouse.move(target.x + 55, target.y + 15, { steps: 6 }); assert.match(await page.locator('[data-file-path="/home/tester/src"]').getAttribute('class'), /drop-active/); await page.mouse.up(); await page.getByRole('alertdialog').waitFor(); };
    await moveIntoSrc();
    assert.match(await page.getByRole('alertdialog').innerText(), /\/home\/tester\/train.py/);
    assert.match(await page.getByRole('alertdialog').innerText(), /\/home\/tester\/src/);
    assert.equal(await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'move').length), 0);
    await page.waitForFunction(() => window.fileFixture.region === null);
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await fs.stat(path.join(remote, 'home/tester/train.py'))).isFile(), true);
    await moveIntoSrc(); await page.getByTestId('files-confirm-operation').click();
    await page.locator('[data-file-path="/home/tester/src/train.py"]').waitFor();
    await assert.rejects(fs.stat(path.join(remote, 'home/tester/train.py')), { code: 'ENOENT' });
    await page.locator('[data-file-path="/home/tester/upload-folder"]').click(); await page.getByTestId('files-trash').click();
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await fs.stat(path.join(remote, 'home/tester/upload-folder'))).isDirectory(), true);
    await page.getByTestId('files-trash').click(); await page.getByTestId('files-confirm-operation').click();
    await page.locator('[data-file-path="/home/tester/upload-folder"]').waitFor({ state: 'detached' });
    await assert.rejects(fs.stat(path.join(remote, 'home/tester/upload-folder')), { code: 'ENOENT' });
    const row = await page.locator('[data-file-path="/home/tester/config.json"]').boundingBox();
    await page.mouse.move(row.x + 55, row.y + 15); await page.mouse.down();
    // Simulate leaving the viewport while pointer capture keeps the gesture alive.
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: innerWidth + 10, clientY: 300, buttons: 1 })));
    await page.mouse.up();
    const drags = await page.evaluate(() => window.fileFixture.calls.filter(call => call.action === 'native-drag'));
    assert.equal(drags.length, 1); assert.deepEqual(drags[0].args.sources, [{ profileId: 'beta', path: '/home/tester/config.json' }]);
    await page.evaluate(() => window.fileFixture.finishDrag());
    const sourcePath = '/home/tester/from-blank', targetPath = '/home/tester/src';
    const sourceFolder = page.locator(`[data-file-path="${sourcePath}"]`);
    const nativeCycle = async () => {
      const before = await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'native-drag').length);
      const start = await sourceFolder.boundingBox(), target = await srcFolder.boundingBox();
      await page.mouse.move(start.x + 60, start.y + 15); await page.mouse.down();
      await page.mouse.move(target.x + 60, target.y + 15, { steps: 6 });
      assert.match(await srcFolder.getAttribute('class'), /drop-active/);
      const tree = await page.locator('.files-tree').boundingBox();
      await page.mouse.move(tree.x + tree.width + 35, target.y + 15, { steps: 6 });
      await page.waitForFunction(n => window.fileFixture.calls.filter(c => c.action === 'native-drag').length === n + 1, before);
      assert.deepEqual(await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'native-drag').at(-1).args.sources), [{ profileId: 'beta', path: sourcePath }]);
      assert.equal(await page.locator('.drop-active').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('files-moving')), false);
      const region = await page.evaluate(() => window.fileFixture.region);
      assert.equal(region.moveRows.find(row => target.y + 15 >= row.top && target.y + 15 < row.bottom)?.allowed, true);
      assert.equal(region.moveRows.find(row => start.y + 15 >= row.top && start.y + 15 < row.bottom)?.allowed, false);
      return { sources: [{ profileId: 'beta', path: sourcePath }], x: target.x + 60, y: target.y + 15, logical: true };
    };
    const transferCount = await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'transfer').length);
    const moveCount = await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'move').length);
    const returning = await nativeCycle();
    for (let pass = 0; pass < 2; pass++) {
      await page.evaluate(event => window.fileFixture.emit('drop', { ...event, type: 'over' }), returning);
      assert.match(await srcFolder.getAttribute('class'), /drop-active/);
      assert.match(await page.locator('.files-drop-label').innerText(), /移动/);
      await page.evaluate(() => window.fileFixture.emit('drop', { type: 'leave' }));
      assert.equal(await page.locator('.drop-active').count(), 0);
    }
    // Native completion may reach the renderer before the final drop event.
    await page.mouse.up(); await page.evaluate(() => window.fileFixture.finishDrag());
    await page.evaluate(event => window.fileFixture.emit('drop', { ...event, type: 'drop' }), returning);
    await page.getByRole('alertdialog').waitFor();
    for (const expected of [sourcePath, targetPath]) assert.ok((await page.getByRole('alertdialog').innerText()).includes(expected));
    assert.equal(await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'move').length), moveCount);
    assert.equal(await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'transfer').length), transferCount);
    await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await fs.stat(path.join(remote, 'home/tester/from-blank'))).isDirectory(), true);
    const outgoing = await nativeCycle();
    await page.evaluate(event => window.fileFixture.emit('drop', { ...event, type: 'over' }), outgoing);
    assert.match(await srcFolder.getAttribute('class'), /drop-active/);
    await page.evaluate(() => window.fileFixture.emit('drop', { type: 'leave' }));
    await page.mouse.up(); await page.evaluate(() => window.fileFixture.finishDrag());
    assert.equal(await page.getByRole('alertdialog').count(), 0, 'finishing outside never opens a move confirmation');
    assert.equal(await page.evaluate(() => window.fileFixture.calls.filter(c => c.action === 'move').length), moveCount);
    const confirmed = await nativeCycle();
    await page.evaluate(event => window.fileFixture.emit('drop', { ...event, type: 'drop' }), confirmed);
    await page.mouse.up(); await page.evaluate(() => window.fileFixture.finishDrag());
    await page.getByTestId('files-confirm-operation').click();
    await page.locator('[data-file-path="/home/tester/src/from-blank"]').waitFor();
    await assert.rejects(fs.stat(path.join(remote, 'home/tester/from-blank')), { code: 'ENOENT' });
    assert.equal((await fs.stat(path.join(remote, 'home/tester/src/from-blank'))).isDirectory(), true);
    // Use a read-only local snapshot when reproducing a reported log, otherwise
    // a synthetic progress log. Neither source is ever written back remotely.
    const log = process.env.LION_EDITOR_LOG_FIXTURE
      ? await fs.readFile(process.env.LION_EDITOR_LOG_FIXTURE, 'utf8')
      : '\rTraining progress: 10%|#         | 100/1000 [00:01<00:09, 100it/s]'.repeat(28000) + '\ncompleted\n';
    const logName = 'newline-regression.err', logPath = `/home/tester/${logName}`;
    const logFile = path.join(remote, 'home/tester', logName);
    await fs.writeFile(logFile, log);
    await page.locator('.files-tree-footer .icon-button').click();
    await page.locator(`[data-file-path="${logPath}"]`).click();
    const logEditor = page.locator('.files-pane:visible .cm-content');
    await page.waitForFunction(p => document.querySelector('.files-pane:not([style*="display: none"]) .cm-content')?.getAttribute('aria-label') === p, logPath);
    assert.equal(await page.locator('.files-tab.active .files-dirty').count(), 0);
    const logLines = log.split(/\r\n?|\n/);
    const rendered = await logEditor.locator('.cm-line').allTextContents();
    assert.ok(rendered.length >= 3); assert.equal(rendered[1], logLines[1]); assert.equal(rendered[2], logLines[2]);
    assert.ok(rendered.every(line => !line.includes('\r') && line.length < 1000));
    await logEditor.click(); await page.keyboard.press('Control+End');
    await page.waitForFunction(lines => [...document.querySelectorAll('.files-pane:not([style*="display: none"]) .cm-lineNumbers .cm-gutterElement')].some(e => e.textContent === String(lines)), logLines.length);
    await page.keyboard.type(' [newline check]'); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.querySelector('.files-tab.active .files-dirty'));
    assert.equal(await fs.readFile(logFile, 'utf8'), log + ' [newline check]');
    // Saving temporarily makes the editor read-only. Refocus before testing
    // its undo shortcut so the browser's own undo handler cannot take over.
    await logEditor.focus(); await page.keyboard.press('Control+z');
    await logEditor.focus(); await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.querySelector('.files-tab.active .files-dirty'));
    assert.equal(await fs.readFile(logFile, 'utf8'), log);
    await logEditor.focus(); await page.keyboard.press('Control+Home');
    await page.screenshot({ path: path.join(output, 'file-newlines.png') });
    assert.deepEqual(errors, []);
    console.log('File manager UI passed: root/expanded tree refresh via button/menu/F5, external changes, collapsed branch reopening, unsaved edits and selection retained, editor/tabs, folder enter arrow, uploads, native drag cycles, moves and delete.');
  } finally {
    clearInterval(events); await browser?.close(); await backend.stop(); await ssh.close();
    assert.equal(path.dirname(fixture), output); await fs.rm(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

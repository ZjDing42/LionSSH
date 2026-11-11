'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { withTerminalClipboardStub } = require('./terminal-rendering.cjs');

// Runs only against the isolated file UI fixture, never the desktop clipboard.
async function verifyFileEditor(page, output) {
  const editor = page.locator('.files-pane:visible .cm-content');
  const menu = async label => {
    await editor.click({ button: 'right', position: { x: 12, y: 15 } });
    await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
  };
  await withTerminalClipboardStub(page, async () => {
    await editor.click(); await page.keyboard.press('Control+a');
    await menu('复制');
    const original = await page.evaluate(() => window.__lionTerminalClipboardTest.text);
    assert.equal(original, '{"epochs": 12}\n');
    await menu('剪切');
    await page.waitForFunction(() => !document.querySelector('.files-pane:not([style*="display: none"]) .cm-content')?.textContent.trim());
    await menu('撤销'); assert.match(await editor.textContent(), /epochs/);
    await menu('重做'); assert.equal((await editor.textContent()).trim(), '');
    await menu('粘贴'); assert.match(await editor.textContent(), /epochs/);
    await menu('全选'); await menu('复制');
    assert.equal(await page.evaluate(() => window.__lionTerminalClipboardTest.text), original);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.querySelector('.files-tab.active .files-dirty'));
    await page.evaluate(() => { window.__lionTerminalClipboardTest.holdReads = true; });
    await menu('粘贴');
    await page.getByRole('tab', { name: /train.py/ }).click();
    await page.evaluate(() => window.__lionTerminalClipboardTest.resolveReads('LATE_PASTE_MUST_NOT_APPEAR'));
    await page.getByRole('tab', { name: /config.json/ }).click();
    assert.doesNotMatch(await editor.textContent(), /LATE_PASTE/);
    assert.equal(await page.locator('.files-tab.active .files-dirty').count(), 0);
    assert.equal(await page.evaluate(() => window.__lionTerminalClipboardTest.calls.every(c => c.userActivation)), true);
    await editor.click({ button: 'right' }); await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
  });
  await editor.click(); await page.keyboard.press('Control+f');
  const panel = page.locator('.files-pane:visible .cm-search');
  await panel.getByPlaceholder('查找', { exact: true }).fill('epochs');
  await panel.getByLabel('区分大小写', { exact: true }).check();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => window.lion.setTheme(theme), theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    // Theme buttons have a 160ms color transition; inspect the settled style.
    await panel.evaluate(async el => {
      for (const field of el.querySelectorAll('.cm-button')) getComputedStyle(field).backgroundColor;
      await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    const styles = await panel.evaluate(el => {
      const probe = document.createElement('span'); probe.style.cssText = 'color:var(--text);background:var(--surface-input)'; el.append(probe);
      const expected = { background: getComputedStyle(probe).backgroundColor, color: getComputedStyle(probe).color }; probe.remove();
      return { expected, fields: [...el.querySelectorAll('.cm-textfield, .cm-button')].map(e => ({ background: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color, image: getComputedStyle(e).backgroundImage })) };
    });
    assert.ok(styles.fields.length >= 7);
    for (const field of styles.fields) { assert.equal(field.background, styles.expected.background); assert.equal(field.color, styles.expected.color); assert.equal(field.image, 'none'); }
    assert.deepEqual(await page.locator('.files-pane:visible .cm-activeLine, .files-pane:visible .cm-activeLineGutter').evaluateAll(es => [...new Set(es.map(e => getComputedStyle(e).backgroundColor))]), ['rgba(0, 0, 0, 0)']);
    await page.screenshot({ path: path.join(output, `file-search-${theme}.png`) });
  }
  await page.evaluate(() => window.lion.setLanguage('en'));
  await panel.getByLabel('match case', { exact: true }).waitFor();
  assert.equal(await panel.getByPlaceholder('Find', { exact: true }).inputValue(), 'epochs');
  assert.equal(await panel.getByLabel('match case', { exact: true }).isChecked(), true);
  for (const label of ['regexp', 'by word']) await panel.getByLabel(label, { exact: true }).waitFor();
  for (const name of ['next', 'previous', 'all', 'replace', 'replace all']) await panel.getByRole('button', { name, exact: true }).waitFor();
  await page.evaluate(() => window.lion.setLanguage('zh'));
  await panel.getByLabel('区分大小写', { exact: true }).waitFor();
  assert.equal(await panel.getByPlaceholder('查找', { exact: true }).inputValue(), 'epochs');
  for (const label of ['正则表达式', '全词匹配']) await panel.getByLabel(label, { exact: true }).waitFor();
  await panel.getByRole('button', { name: '关闭', exact: true }).click();
  for (const width of [900, 1450, 1920, 2560]) {
    await page.setViewportSize({ width, height: 980 });
    // A stable scrollbar gutter belongs to the viewport, outside the body content.
    const bounds = await page.locator('.workspace').evaluate(e => ({ right: e.getBoundingClientRect().right, width: e.getBoundingClientRect().width, contentRight: document.body.getBoundingClientRect().right, overflow: document.documentElement.scrollWidth > innerWidth, leftPadding: getComputedStyle(e).paddingLeft, rightPadding: getComputedStyle(e).paddingRight }));
    assert.equal(bounds.right, bounds.contentRight); assert.equal(bounds.overflow, false);
    assert.equal(bounds.leftPadding, '44px'); assert.equal(bounds.rightPadding, '44px');
    if (width > 1900) assert.ok(bounds.width > 1440);
  }
  await page.setViewportSize({ width: 1450, height: 980 });
}
module.exports = { verifyFileEditor };

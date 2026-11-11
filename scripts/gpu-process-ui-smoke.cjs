'use strict';
// Exercise the real renderer with local samples; no SSH or real process actions.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function fixture(page) {
  await page.addInitScript(() => {
    const clone = value => JSON.parse(JSON.stringify(value));
    const processes = Array.from({ length: 24 }, (_, index) => ({ pid: 500 - index, name: '/usr/bin/python', username: ['qihang', 'chenxi', 'dzj'][index % 3], elapsedSeconds: 1000 + index, memoryUsedMiB: 256, canStop: index % 3 === 2, startTicks: String(100 + index) }));
    const cards = Array.from({ length: 8 }, (_, index) => ({ index, uuid: `gpu-${index}`, name: 'NVIDIA GeForce RTX 4090', utilization: 37, memoryUsedMiB: 11796, memoryTotalMiB: 24576, idle: false, stableCount: 2, computeProcesses: 24, processes: index === 1 ? [{ ...processes[0], username: 'single' }] : processes }));
    const gpu = { enabled: true, intervalSec: 30, idleUtil: 5, idleMemoryMiB: 512, stableSamples: 2 };
    const profile = { id: 'gpu-test', name: 'GPU UI fixture', host: 'example.test', port: 22, username: 'dzj', authType: 'key', keyPath: '', autoReconnect: false, gpu, tunnels: [] };
    const state = { profileId: profile.id, status: 'connected', gpu: { status: 'ready', availability: 'available', cards, total: 8, idleCount: 0, intervalSec: 30, lastUpdated: Date.now(), nextPollAt: Date.now() + 30000 }, tunnels: [], events: [] };
    let onState = () => {};
    window.__gpuFixture = { state, signals: [], send() { onState(clone(state)); } };
    window.lion = {
      getInitial: async () => ({ profiles: [clone(profile)], states: [clone(state)], version: '1.11.0', theme: { preference: 'light', resolved: 'light' }, language: { preference: 'zh', resolved: 'zh' } }),
      setTheme: async preference => ({ preference, resolved: preference }),
      setLanguage: async preference => ({ preference, resolved: preference }),
      onState: callback => { onState = callback; return () => {}; },
      onLanguage: () => () => {}, onTheme: () => () => {}, onHostKey: () => () => {}, onShutdown: () => () => {},
      refreshGpu: async () => { state.gpu.lastUpdated = Date.now(); onState(clone(state)); },
      prepareGpuProcessStop: async (_id, _uuid, pid) => ({ pid, name: '/usr/bin/python', username: 'dzj', token: 'fixture-token', expiresAt: Date.now() + 60000 }),
      stopGpuProcess: async (_id, token, mode) => { window.__gpuFixture.signals.push({ token, mode }); return { signalled: true }; },
    };
  });
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('.workspace').getBoundingClientRect();
    const origin = document.querySelector('.gpu-detail').getBoundingClientRect();
    return { x: rect.x, width: rect.width, cardX: origin.x, cardWidth: origin.width, scrollY, overflow: document.body.style.overflow, padding: document.body.style.paddingRight };
  });
}
function sameGeometry(actual, expected, label) {
  for (const key of ['x', 'width', 'cardX', 'cardWidth', 'scrollY']) assert(Math.abs(actual[key] - expected[key]) < .1, `${label} ${key}: ${expected[key]} -> ${actual[key]}`);
}
const waitOpen = page => page.locator('.gpu-process-overlay[data-motion="open"]').waitFor();
const waitClosed = page => page.locator('.gpu-process-overlay').waitFor({ state: 'detached' });
async function contrast(page) {
  return page.locator('.gpu-process-table td').first().evaluate(td => {
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const foreground = getComputedStyle(td).color;
    const surface = getComputedStyle(td.closest('.gpu-process-table-wrap')).backgroundColor;
    const luminance = color => rgb(color).map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const a = luminance(foreground), b = luminance(surface);
    const probe = document.createElement('span'); probe.style.color = 'var(--text)'; document.body.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return { foreground, expected, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  });
}

(async () => {
  const output = path.resolve('test-output/gpu-processes'); await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--allow-file-access-from-files'] });
  const errors = [], reports = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 }, locale: 'zh-CN' });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await fixture(page); await page.goto(pathToFileURL(path.resolve('dist/index.html')).href);
    await page.getByTestId('gpu-card').waitFor();
    await page.getByRole('button', { name: '查看显卡详情', exact: true }).click();
    const firstCard = page.locator('.gpu-detail').first();
    await firstCard.locator('.gpu-user-badge').hover();
    await page.locator('.gpu-user-popover').waitFor();
    assert.deepEqual(await page.locator('.gpu-user-popover li').allTextContents(), ['chenxi', 'dzj']);
    assert.equal(await firstCard.locator('.gpu-user-badge').getAttribute('title'), null);
    await page.locator('.gpu-user-popover li').first().hover();
    await page.waitForTimeout(220);
    assert.equal(await page.locator('.gpu-user-popover').count(), 1, 'pointer can enter the custom list');
    await firstCard.locator('.gpu-user-badge').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.gpu-user-popover').count(), 0);
    const singleBadge = await page.locator('.gpu-detail').nth(1).locator('.gpu-user-badge').boundingBox();
    await page.mouse.move(singleBadge.x + singleBadge.width / 2, singleBadge.y + singleBadge.height / 2);
    assert.equal(await page.locator('.gpu-user-popover').count(), 0, 'single user has no popover');
    for (const theme of ['light', 'dark']) {
      await page.getByTestId(`theme-${theme}`).click();
      for (const fallback of [false, true]) {
        await page.evaluate(fallback => { document.documentElement.style.scrollbarGutter = fallback ? 'auto' : ''; window.scrollTo(0, 80); }, fallback);
        const before = await geometry(page);
        await firstCard.locator('.gpu-detail-open').click(); await waitOpen(page);
        sameGeometry(await geometry(page), before, `open/${theme}/${fallback}`);
        const color = await contrast(page); assert.equal(color.foreground, color.expected); assert(color.ratio >= 4.5);
        await page.locator('.gpu-process-panel').screenshot({ path: path.join(output, `panel-${theme}.png`) });
        await page.locator('.gpu-process-table-wrap').evaluate(el => { el.scrollTop = 170; });
        await page.evaluate(() => {
          window.__motionFrames = [];
          document.querySelector('.gpu-process-panel button[aria-label="关闭"]').click();
          const capture = () => {
            if (!document.querySelector('.gpu-process-overlay')) return;
            const shell = document.querySelector('.gpu-process-morph');
            if (shell) {
              const layers = [...shell.children];
              window.__motionFrames.push({ width: shell.getBoundingClientRect().width, blur: getComputedStyle(shell).filter, cardOpacity: Number(layers[0].style.opacity), detailOpacity: Number(layers[1].style.opacity), scroll: layers[1].querySelector('.gpu-process-table-wrap').scrollTop, text: getComputedStyle(layers[1].querySelector('td')).color });
            }
            requestAnimationFrame(capture);
          };
          requestAnimationFrame(capture);
        });
        await waitClosed(page);
        const frames = await page.evaluate(() => window.__motionFrames);
        assert(frames.length > 1, 'Gaussian return ran');
        assert(frames.some(f => parseFloat(f.blur.slice(5)) > 2), 'content blurs during morph');
        assert(frames.every(f => f.cardOpacity + f.detailOpacity > .99), 'no empty card during return');
        assert(frames.every(f => f.scroll === 170), 'closing snapshot preserves table scroll');
        assert(frames.every(f => f.text === color.expected), 'snapshot follows the live theme');
        for (let i = 1; i < frames.length; i++) assert(frames[i].width <= frames[i - 1].width + .2, 'no full-size flash');
        sameGeometry(await geometry(page), before, `close/${theme}/${fallback}`);
        assert.equal(await firstCard.evaluate(el => el.style.opacity), '');
        assert.equal(await page.evaluate(() => document.body.style.overflow), before.overflow);
        reports.push({ theme, fallback, color, frames: frames.length });
      }
      await firstCard.locator('.gpu-detail-open').click(); await waitOpen(page);
      await page.evaluate(() => {
        window.__particleFrames = [];
        document.querySelector('.gpu-process-backdrop').click();
        const capture = () => {
          const panel = document.querySelector('.gpu-process-panel'); if (!panel) return;
          const canvas = document.querySelector('.gpu-process-particles');
          window.__particleFrames.push({ filter: panel.style.filter, mask: panel.style.maskImage, canvas: Boolean(canvas), canvasFilter: canvas ? getComputedStyle(canvas).filter : '' });
          requestAnimationFrame(capture);
        };
        requestAnimationFrame(capture);
      });
      await waitClosed(page);
      const particles = await page.evaluate(() => window.__particleFrames);
      assert(particles.some(f => f.canvas && f.filter === 'blur(8px)' && f.mask), 'central remnant blurs during edge dissolve');
      assert(particles.filter(f => f.canvas).every(f => f.canvasFilter === 'none'), 'particle layer remains sharp');
      assert.equal(await page.locator('.gpu-process-particles, .gpu-process-morph').count(), 0);
    }
    await page.evaluate(() => { document.documentElement.style.scrollbarGutter = ''; });
    // Confirmation stays live and independent of the decorative snapshots.
    await firstCard.locator('.gpu-detail-open').click(); await waitOpen(page);
    await page.locator('.gpu-stop-button').first().click();
    await page.getByRole('alertdialog').waitFor();
    assert((await page.locator('.gpu-stop-warning').innerText()).includes('slurm'));
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.__gpuFixture.signals), []);
    await page.keyboard.press('Escape'); await waitClosed(page);
    // Interrupted animations must restore the source and page scroll.
    for (const interrupt of ['escape', 'disconnect']) {
      await firstCard.locator('.gpu-detail-open').click();
      await page.locator('.gpu-process-overlay').waitFor();
      if (interrupt === 'escape') await page.keyboard.press('Escape');
      else await page.evaluate(() => { window.__gpuFixture.state.status = 'disconnected'; window.__gpuFixture.send(); });
      await waitClosed(page);
      assert.equal(await page.evaluate(() => document.body.style.overflow), '');
      assert.equal(await firstCard.evaluate(el => el.style.opacity), '');
      assert.equal(await page.locator('.gpu-process-particles, .gpu-process-morph').count(), 0);
      await page.evaluate(() => { window.__gpuFixture.state.status = 'connected'; window.__gpuFixture.send(); });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const route of ['blur', 'particles']) {
      await firstCard.locator('.gpu-detail-open').click(); await waitOpen(page);
      if (route === 'blur') await page.keyboard.press('Escape'); else await page.locator('.gpu-process-backdrop').click({ position: { x: 10, y: 10 } });
      await waitClosed(page); assert.equal(await page.locator('.gpu-process-particles, .gpu-process-morph').count(), 0);
    }
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.getByTestId('language-select').selectOption('en');
    await firstCard.locator('.gpu-user-badge').focus();
    assert.equal(await page.locator('.gpu-user-popover p').textContent(), 'Other users');
    assert(await page.locator('.gpu-user-popover').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
    await page.getByTestId('gpu-card').screenshot({ path: path.join(output, 'custom-users.png') });
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output, 'motion-smoke.json'), JSON.stringify({ passed: true, reports, errors }, null, 2));
    console.log('GPU panel smoke passed: custom user list, theme contrast, Gaussian handoff, blurred edge dissolve, scrollbar stability, confirmation, interruption and reduced motion.');
    console.log(JSON.stringify(reports));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

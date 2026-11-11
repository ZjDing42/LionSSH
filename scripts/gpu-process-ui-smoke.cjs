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
const openTrigger = '.gpu-detail .gpu-detail-open';
const closeTriggers = {
  button: '.gpu-process-panel button[aria-label="关闭"]',
  backdrop: '.gpu-process-backdrop',
};

async function captureMorph(page, trigger, opening) {
  await page.evaluate(({ trigger, opening }) => {
    const frames = window.__motionFrames = [];
    const origin = document.querySelector('.gpu-detail');
    const capture = () => {
      const overlay = document.querySelector('.gpu-process-overlay');
      if (window.__motionFrames !== frames || !overlay || (opening && overlay.dataset.motion === 'open')) return;
      const shell = overlay.querySelector('.gpu-process-morph');
      if (shell) {
        const [card, detail] = shell.children;
        const cardWidth = origin.getBoundingClientRect().width;
        const panelWidth = overlay.querySelector('.gpu-process-panel:not(.gpu-motion-layer)').getBoundingClientRect().width;
        frames.push({
          position: (shell.getBoundingClientRect().width - cardWidth) / (panelWidth - cardWidth),
          blur: parseFloat(getComputedStyle(shell).filter.slice(5)),
          cardOpacity: Number(card.style.opacity),
          detailOpacity: Number(detail.style.opacity),
          scroll: detail.querySelector('.gpu-process-table-wrap').scrollTop,
          text: getComputedStyle(detail.querySelector('td')).color,
          particles: Boolean(overlay.querySelector('.gpu-process-particles')),
        });
      }
      requestAnimationFrame(capture);
    };
    document.querySelector(trigger).click();
    requestAnimationFrame(capture);
  }, { trigger, opening });
  await (opening ? waitOpen(page) : waitClosed(page));
  return page.evaluate(() => window.__motionFrames);
}

function checkMorph(frames, opening, color) {
  const direction = opening ? 1 : -1;
  assert(frames.some(frame => frame.blur > 2), 'content blurs during the morph');
  assert(frames.every(frame => frame.cardOpacity + frame.detailOpacity > .99), 'no empty frame during the morph');
  assert(frames.every(frame => frame.text === color && !frame.particles), 'the morph uses the themed snapshots without particles');
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1].position, current = frames[i].position;
    assert(direction * (current - previous) >= -.002, `the shell resizes continuously during ${opening ? 'opening' : 'closing'} (${previous} → ${current})`);
  }
  const next = frames.findIndex(frame => direction * (frame.detailOpacity - .5) >= 0);
  assert(next > 0, 'the recording captures both sides of the card/table handoff');
  const [a, b] = frames.slice(next - 1, next + 1);
  const fraction = (.5 - a.detailOpacity) / (b.detailOpacity - a.detailOpacity);
  return a.position + (b.position - a.position) * fraction;
}

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
        for (const [route, trigger] of Object.entries(closeTriggers)) {
          const opened = await captureMorph(page, openTrigger, true);
          sameGeometry(await geometry(page), before, `open/${theme}/${fallback}/${route}`);
          const color = await contrast(page); assert.equal(color.foreground, color.expected); assert(color.ratio >= 4.5);
          if (!fallback && route === 'button') await page.locator('.gpu-process-panel').screenshot({ path: path.join(output, `panel-${theme}.png`) });
          await page.locator('.gpu-process-table-wrap').evaluate(el => { el.scrollTop = 170; });
          const closed = await captureMorph(page, trigger, false);
          const openHandoff = checkMorph(opened, true, color.expected);
          const closeHandoff = checkMorph(closed, false, color.expected);
          assert(openHandoff < .35, `the table takes over early in the expansion (${openHandoff})`);
          assert(Math.abs(openHandoff - closeHandoff) < .07, `handoff width matches in both directions (${openHandoff} vs ${closeHandoff})`);
          assert(closed.every(frame => frame.scroll === 170), 'closing snapshot preserves table scroll');
          sameGeometry(await geometry(page), before, `close/${theme}/${fallback}/${route}`);
          assert.equal(await firstCard.evaluate(el => el.style.opacity), '');
          assert.equal(await page.evaluate(() => document.body.style.overflow), before.overflow);
          reports.push({ theme, fallback, route, color, openHandoff, closeHandoff });
        }
      }
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
    for (const route of ['button', 'backdrop']) {
      await firstCard.locator('.gpu-detail-open').click(); await waitOpen(page);
      if (route === 'button') await page.locator(closeTriggers.button).click();
      else await page.locator(closeTriggers.backdrop).click({ position: { x: 10, y: 10 } });
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
    console.log('GPU panel smoke passed: custom user list, theme contrast, matching Gaussian handoff in both directions and close paths, scrollbar stability, confirmation, interruption and reduced motion.');
    console.log(JSON.stringify(reports));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

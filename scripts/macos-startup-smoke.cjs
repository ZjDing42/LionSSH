'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

async function startupSmoke(app) {
  assert.equal(process.platform, 'darwin', 'This check requires macOS');
  app = path.resolve(app);
  const plist = path.join(app, 'Contents', 'Info.plist');
  const name = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
  assert.equal(path.basename(name), name);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'lion-startup-'));
  const reportPath = path.join(fixture, 'result.json');
  let log = '';
  try {
    const child = spawn(path.join(app, 'Contents', 'MacOS', name), ['--smoke', '--verification-instance'], {
      cwd: fixture,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LION_DATA_DIR: path.join(fixture, 'data'), LION_VERIFY_ROOT: fixture,
        LION_VERIFY_INSTANCE_ID: randomUUID(), LION_SMOKE_RESULT: reportPath, RUST_BACKTRACE: 'full' },
    });
    child.stdout.on('data', data => { log = (log + data.toString()).slice(-30000); });
    child.stderr.on('data', data => { log = (log + data.toString()).slice(-30000); });
    const status = await new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 45000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, expired }); });
    });
    console.log(JSON.stringify({ app, ...status, log }, null, 2));
    assert.equal(status.expired, false, 'macOS startup timed out');
    assert.equal(status.code, 0, `macOS app exited with ${status.signal || status.code}`);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    assert.equal(report.ok, true, report.error);
    assert.deepEqual(report.initial.profiles, []);
    console.log('macOS packaged startup, native webview/drop initialization and backend snapshot passed.');
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
}

if (require.main === module) {
  const app = process.argv[2] || JSON.parse(process.env.MACOS_ARTIFACT_PATHS || '[]').find(file => file.endsWith('.app'));
  startupSmoke(app).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { startupSmoke };

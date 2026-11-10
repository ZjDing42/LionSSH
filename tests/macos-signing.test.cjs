'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyApp } = require('../scripts/verify-macos-bundles.cjs');

test('macOS verification rejects linker-only signatures and tampered bundle resources', { skip: process.platform !== 'darwin' }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-signing-test-'));
  const app = path.join(temp, 'Fixture App.app');
  const contents = path.join(app, 'Contents');
  const expected = { identifier: 'tools.lion.signing-test', version: '1.0.0', architecture: process.arch === 'arm64' ? 'arm64' : 'x86_64' };
  try {
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'));
    const resource = path.join(contents, 'Resources', 'fixture.txt');
    fs.writeFileSync(resource, 'Original resource');
    const plist = path.join(contents, 'Info.plist');
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${expected.identifier}</string>
<key>CFBundleShortVersionString</key><string>${expected.version}</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
    const executable = path.join(contents, 'MacOS', 'fixture');
    execFileSync('/usr/bin/cc', ['-x', 'c', '-o', executable, '-'], { input: 'int main(void) { return 0; }' });
    assert.throws(() => verifyApp(app, expected), /missing bundle resource seal/);

    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    const original = verifyApp(app, expected);
    fs.writeFileSync(resource, 'Tampered resource');
    assert.throws(() => verifyApp(app, expected), /codesign failed/);
    fs.writeFileSync(resource, 'Original resource');
    assert.deepEqual(verifyApp(app, expected), original);

    fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace('1.0.0', '2.0.0'));
    assert.throws(() => verifyApp(app, expected), /codesign failed/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

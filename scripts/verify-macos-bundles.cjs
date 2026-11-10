'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${output}`);
  return output;
}

function verifyApp(app, expected) {
  const contents = path.join(app, 'Contents');
  const seal = path.join(contents, '_CodeSignature', 'CodeResources');
  assert.ok(fs.existsSync(seal) && fs.statSync(seal).size > 0, `${app}: missing bundle resource seal`);
  // This checks bundle integrity, not Developer ID trust or notarization.
  const verification = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', app]);
  assert.doesNotMatch(signature, /linker-signed|Info\.plist=not bound|Sealed Resources=none/, `${app}: incomplete bundle signature`);
  assert.equal(signature.match(/^Identifier=(.+)$/m)?.[1], expected.identifier, `${app}: signing identifier mismatch`);

  const plist = path.join(contents, 'Info.plist');
  const readPlist = key => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
  assert.equal(readPlist('CFBundleIdentifier'), expected.identifier, `${app}: bundle identifier mismatch`);
  assert.equal(readPlist('CFBundleShortVersionString'), expected.version, `${app}: version mismatch`);
  const executableName = readPlist('CFBundleExecutable');
  assert.ok(executableName && path.basename(executableName) === executableName, `${app}: invalid executable name`);
  const executable = path.join(contents, 'MacOS', executableName);
  assert.equal(run('/usr/bin/lipo', ['-archs', executable]), expected.architecture, `${app}: architecture mismatch`);
  const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  console.log(`Verified ${app}\n${verification}\n${signature}`);
  return { executable: sha256(executable), resources: sha256(seal), plist: sha256(plist) };
}

function verifyBundles(target, artifactPaths) {
  assert.equal(process.platform, 'darwin', 'macOS bundle verification must run on macOS');
  const architecture = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' }[target];
  assert.ok(architecture, `Unsupported macOS target: ${target}`);
  assert.ok(Array.isArray(artifactPaths) && artifactPaths.every(file => typeof file === 'string'), 'Expected Tauri artifact paths');
  const artifact = suffix => {
    const matches = artifactPaths.filter(file => file.endsWith(suffix));
    assert.equal(matches.length, 1, `Expected one ${suffix} artifact, found ${matches.length}`);
    return path.resolve(matches[0]);
  };
  const app = artifact('.app');
  const archive = artifact('.app.tar.gz');
  const dmg = artifact('.dmg');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const expected = { identifier: config.identifier, version: config.version, architecture };
  const original = verifyApp(app, expected);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-macos-verify-'));
  const extracted = path.join(temp, 'updater');
  const mount = path.join(temp, 'dmg');
  let mounted = false;
  try {
    fs.mkdirSync(extracted);
    run('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
    assert.deepEqual(verifyApp(path.join(extracted, path.basename(app)), expected), original, 'Updater app differs from the signed build');

    fs.mkdirSync(mount);
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    mounted = true;
    assert.deepEqual(verifyApp(path.join(mount, path.basename(app)), expected), original, 'DMG app differs from the signed build');
    console.log(`macOS ${architecture}: build, updater archive and DMG signatures all verified.`);
  } finally {
    // Never remove a mounted volume if detaching fails; leave the owned temp directory for diagnosis.
    if (mounted) run('/usr/bin/hdiutil', ['detach', mount]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { verifyBundles(process.argv[2], JSON.parse(process.env.MACOS_ARTIFACT_PATHS || 'null')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { verifyApp };

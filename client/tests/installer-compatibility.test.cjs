'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REQUIRED_CHECKS, hashBuildInput, validateReport, readBuildInputs } = require('../scripts/installer-compatibility-report.cjs');
const artifact = { version: '1.12.37', size: 2000000, sha256: 'a'.repeat(64), platform: 'win32', arch: 'x64' };
function good() {
  return { schema: 1, kind: 'soduwork-windows-installer-compatibility', ok: true, artifact: { ...artifact },
    checks: REQUIRED_CHECKS.map(name => ({ name, status: 'passed', exitCode: 0 })),
    evidence: { runtime: { runnerStarted: true, restored: true },
      notices: { compatibilityPassed: true, runtimeCorruptionRejected: true, restored: true } } };
}
test('build input hashes are stable across Windows and Linux line endings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-build-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lf = path.join(root, 'lf.txt'), crlf = path.join(root, 'crlf.txt');
  fs.writeFileSync(lf, 'first\nsecond\n');
  fs.writeFileSync(crlf, 'first\r\nsecond\r\n');
  assert.equal(hashBuildInput(lf), hashBuildInput(crlf));
});
test('compatibility receipt accepts only the exact tested artifact and complete checks', () => {
  assert.equal(validateReport(good(), artifact).ok, true);
  for (const key of Object.keys(artifact)) {
    const changed = { ...artifact, [key]: key === 'size' ? artifact.size + 1 : artifact[key] + '-other' };
    assert.throws(() => validateReport(good(), changed), /does not match installer/);
  }
  for (const name of REQUIRED_CHECKS) for (const status of ['failed', 'skipped', 'running', 'missing']) {
    const report = good();
    if (status === 'missing') report.checks = report.checks.filter(check => check.name !== name);
    else report.checks.find(check => check.name === name).status = status;
    assert.throws(() => validateReport(report, artifact), /compatibility check/);
  }
  const failed = good(); failed.checks[0].exitCode = 2;
  assert.throws(() => validateReport(failed, artifact), /did not exit successfully/);
  const duplicate = good(); duplicate.checks.push(duplicate.checks[0]);
  assert.throws(() => validateReport(duplicate, artifact), /Duplicate/);
  const unconfirmed = good(); unconfirmed.ok = false;
  assert.throws(() => validateReport(unconfirmed, artifact), /has not passed/);
});
test('compatibility receipt requires bootable runtime, restored files and corruption rejection', () => {
  for (const [scope, key] of [['runtime', 'runnerStarted'], ['runtime', 'restored'],
    ['notices', 'compatibilityPassed'], ['notices', 'runtimeCorruptionRejected'], ['notices', 'restored']]) {
    const report = good(); report.evidence[scope][key] = false;
    assert.throws(() => validateReport(report, artifact));
  }
});
test('real uploader refuses missing or mismatched compatibility evidence before signing or network access', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-release-compatibility-'));
  t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
  const installer = path.join(root, 'SoduWork-1.12.37-Setup.exe');
  const receipt = installer + '.compatibility.json', bundle = path.join(root, 'never-signed.json');
  fs.writeFileSync(installer, Buffer.alloc(2000000));
  const uploader = path.resolve(__dirname, '../../tools/sign-client-release.mjs');
  function run(file = installer) {
    const env = { ...process.env, SODUWORK_CLIENT_COMPATIBILITY_REPORT: receipt,
      SODUWORK_CLIENT_RELEASE_BUNDLE: bundle, SODUWORK_CLIENT_SIGNING_KEY_FILE: '',
      SODUWORK_CLIENT_RELEASE_UPLOAD_URL: '', SODUWORK_CLIENT_RELEASE_UPLOAD_TOKEN: '' };
    const result = spawnSync(process.execPath, [uploader, file], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 1); assert.equal(fs.existsSync(bundle), false);
    return result;
  }
  assert.match(run().stderr, /compatibility receipt is required/);
  fs.writeFileSync(receipt, JSON.stringify(good()));
  assert.match(run().stderr, /does not match installer: sha256/);
  const valid = good();
  valid.artifact.sha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  valid.buildInputs = readBuildInputs(path.resolve(__dirname, '..'));
  fs.writeFileSync(receipt, JSON.stringify(valid));
  assert.match(run().stderr, /SIGNING_KEY_FILE is required/);
  // Only the canonical installer filename is accepted.
  const otherName = path.join(root, 'OtherBrand-1.12.37-Setup.exe');
  fs.copyFileSync(installer, otherName);
  assert.match(run(otherName).stderr, /installer filename does not match/);
  // A passing receipt cannot authorize a different HTML packing policy,
  // even when the installer file and every other build input still match.
  const htmlInput = 'scripts/prepare-html-resources.cjs';
  const htmlDigest = valid.buildInputs[htmlInput];
  assert.equal(htmlDigest, hashBuildInput(path.resolve(__dirname, '..', htmlInput)));
  delete valid.buildInputs[htmlInput];
  fs.writeFileSync(receipt, JSON.stringify(valid));
  assert.match(run().stderr, /build code changed/);
  valid.buildInputs[htmlInput] = 'changed-html-packing-policy';
  fs.writeFileSync(receipt, JSON.stringify(valid));
  assert.match(run().stderr, /build code changed/);
  valid.buildInputs[htmlInput] = htmlDigest;
  valid.buildInputs['build/installer.nsh'] = 'changed-source';
  fs.writeFileSync(receipt, JSON.stringify(valid));
  assert.match(run().stderr, /build code changed/);
  fs.writeFileSync(receipt, JSON.stringify({ ...good(), ok: false }));
  assert.match(run().stderr, /has not passed/);
});

test('isolated compatibility fixture loads real distribution and update trust', async t => {
  const { copyFixture } = require('../scripts/installer-compatibility-gate.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-compatibility-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await copyFixture(path.resolve(__dirname, '..'), root);
  const result = spawnSync(process.execPath, ['-e', "const d=require('./main/distribution.cjs'); console.log(JSON.stringify(d.getProfile()))"],
    { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).updateTrust, require('../update-trust.json'));
  assert.equal(fs.existsSync(path.join(root, '.runtime')), false);
});

'use strict';
const assert = require('node:assert/strict');
const REQUIRED_CHECKS = Object.freeze([
  'native-boundaries', 'install-update-recovery', 'notice-installation',
  'bootstrap-installation-compatibility', 'runtime-rejection-rollback', 'delivered-payload', 'delivered-runtime',
  'delivered-notices', 'restored-payload', 'static-text-installation',
  'packaged-runner-lifecycle', 'packaged-runner-task',
]);
const BUILD_INPUTS = Object.freeze([
  'build/installer.nsh', 'build/installer-language.nsh', 'build/install-versioned.nsh', 'build/package-check.nsh',
  'build/soduwork-install-identity.nsh', 'build/file-open.nsh',
  'build/launcher.nsi', 'build/launcher-progress.nsh', 'build/verify-payload.cjs', 'build/prune-versions.cjs',
  'scripts/native-payload.cjs', 'scripts/payload-sources.cjs', 'scripts/prepare-installer.cjs',
  'scripts/client-build-version.cjs',
  'scripts/prepare-html-resources.cjs', 'scripts/prepare-runner.cjs',
  'main/runner-runtime.js', 'package.json', '../hub-backend/runner.spec',
  '../hub-backend/runner_main.py', '../hub-backend/app/services/runner_lifecycle.py',
  '../hub-backend/app/services/runner_node.py', 'e2e/packaged-runner.cjs',
  '../hub-backend/app/services/local_process.py', '../hub-backend/scripts/check_packaged_runner.py',
  '../hub-backend/scripts/check_packaged_runner_task.py',
]);
function readBuildInputs(client) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  return Object.fromEntries(BUILD_INPUTS.map(name => [name,
    hashBuildInput(path.join(client, name), fs, crypto)]));
}
function hashBuildInput(file, fs = require('node:fs'), crypto = require('node:crypto')) {
  // Windows checkouts may contain CRLF while Linux publish jobs use LF. Hash the
  // text content in one canonical form so the same source commit has one receipt.
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
function validateReport(report, artifact, expectedInputs) {
  assert.equal(report?.schema, 1, 'Unsupported installer compatibility receipt');
  assert.equal(report.kind, 'soduwork-windows-installer-compatibility');
  assert.equal(report.ok, true, 'Installer compatibility gate has not passed');
  for (const key of ['version', 'sha256', 'size', 'platform', 'arch']) {
    assert.equal(report.artifact?.[key], artifact[key], 'Compatibility receipt does not match installer: ' + key);
  }
  assert.ok(Array.isArray(report.checks));
  const names = report.checks.map(check => check.name);
  assert.equal(new Set(names).size, names.length, 'Duplicate compatibility check');
  for (const name of REQUIRED_CHECKS) {
    const check = report.checks.find(check => check.name === name);
    assert.equal(check?.status, 'passed', 'Missing/failed installer compatibility check: ' + name);
    assert.equal(check.exitCode, 0, 'Installer compatibility check did not exit successfully: ' + name);
  }
  assert.ok(report.checks.every(check => check.status === 'passed' && check.exitCode === 0));
  assert.equal(report.evidence?.runtime?.runnerStarted, true);
  assert.equal(report.evidence.runtime.restored, true);
  assert.equal(report.evidence?.notices?.compatibilityPassed, true);
  assert.equal(report.evidence.notices.runtimeCorruptionRejected, true);
  assert.equal(report.evidence.notices.restored, true);
  if (expectedInputs) assert.deepEqual(report.buildInputs, expectedInputs, 'Installer build code changed after compatibility verification');
  return report;
}
module.exports = { REQUIRED_CHECKS, BUILD_INPUTS, hashBuildInput, readBuildInputs, validateReport };

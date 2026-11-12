'use strict';
// Test the exact deliverable, using a separate build project for mutation fixtures.
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream, existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { validateReport, readBuildInputs } = require('./installer-compatibility-report.cjs');
const { candidateVersion, displayVersions } = require('./client-build-version.cjs');
const client = path.resolve(__dirname, '..');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function fingerprint(file) {
  const hash = crypto.createHash('sha256'); let size = 0;
  for await (const bytes of createReadStream(file)) { hash.update(bytes); size += bytes.length; }
  return { size, sha256: hash.digest('hex') };
}
async function copyFixture(source, target) {
  for (const name of ['build', 'scripts', 'e2e', 'tests', 'main', 'package.json', 'update-trust.json', 'icon.ico']) {
    await fs.cp(path.join(source, name), path.join(target, name), { recursive: true });
  }
}
async function main() {
  const [input, destination] = process.argv.slice(2);
  assert.ok(input && path.isAbsolute(input), 'Usage: node installer-compatibility-gate.cjs <absolute installer.exe> [new report.json]');
  assert.equal(process.platform, 'win32', 'Windows installer checks require Windows');
  assert.equal(process.arch, 'x64', 'This matrix currently validates Windows x64 only');
  const installer = path.resolve(input), reportFile = path.resolve(destination || installer + '.compatibility.json');
  assert.equal(existsSync(reportFile), false, 'Keep historical evidence; use a new receipt path');
  const version = candidateVersion(process.env, path.resolve(client, '..'));
  assert.ok(displayVersions(version).some(value => path.basename(installer).startsWith('SoduWork-' + value + '-')), 'Installer and source versions must match');
  // Never pass diagnostic switches to an older production installer.
  const semver = require('semver');
  assert.ok(semver.valid(version) && semver.gte(version, '1.12.37'), 'Package check requires SoduWork 1.12.37 or later');
  const metadata = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::Write([Diagnostics.FileVersionInfo]::GetVersionInfo($env:SODUWORK_GATE_INSTALLER).ProductVersion)'],
    { env: { ...process.env, SODUWORK_GATE_INSTALLER: installer }, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(metadata.status, 0, 'Cannot read installer version metadata');
  assert.ok(displayVersions(version).includes(metadata.stdout.trim()), 'Actual EXE version differs from reviewed source');
  const buildInputs = readBuildInputs(client);
  const artifact = { name: path.basename(installer), version, platform: 'win32', arch: 'x64', ...await fingerprint(installer) };
  assert.ok(artifact.size >= 1024 * 1024);
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  const work = await fs.mkdtemp(path.join(path.dirname(reportFile), 'installer-compatibility-'));
  const fixture = path.join(work, 'fixture-project'), payload = path.join(work, 'payload');
  await fs.mkdir(fixture); await fs.mkdir(payload);
  const report = { schema: 1, kind: 'soduwork-windows-installer-compatibility', ok: false,
    startedAt: new Date().toISOString(), artifact, buildInputs, host: { platform: process.platform, arch: process.arch,
      release: os.release(), node: process.versions.node }, work, checks: [], evidence: {},
    limitations: ['Corporate filesystem filters are simulated; this does not certify a customer machine.',
      'This host does not represent every supported Windows version or machine-wide UAC policy.'] };
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: client, encoding: 'utf8', windowsHide: true });
  report.sourceCommit = git.status === 0 ? git.stdout.trim() : null;
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: client, encoding: 'utf8', windowsHide: true });
  report.sourceWorkingTreeDirty = dirty.status !== 0 || !!dirty.stdout.trim();
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  // Developer shortcuts must never convert a release check into a build-only pass.
  for (const name of Object.keys(env)) if (/^SODUWORK_E2E_|^ELECTRON_RUN_AS_NODE$/i.test(name)) delete env[name];
  async function check(name, args, timeoutMs = 600000) {
    const entry = { name, status: 'running', log: path.join(work, name + '.log') };
    report.checks.push(entry); const start = Date.now();
    console.log('Installer compatibility: ' + name);
    const log = createWriteStream(entry.log, { flags: 'wx' });
    try {
      entry.exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: fixture, env, windowsHide: true });
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
        const timer = setTimeout(() => {
          // Kill only the process tree started for this isolated check.
          if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          reject(Error(name + ' timed out'));
        }, timeoutMs);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(entry.exitCode, 0, 'Installer compatibility check failed: ' + name);
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; throw error; }
    finally { entry.durationMs = Date.now() - start; await new Promise(resolve => log.end(resolve)); }
  }
  try {
    // No .runtime output or production data is shared with test fixture builds.
    await copyFixture(client, fixture);
    await fs.symlink(await fs.realpath(path.join(client, 'node_modules')), path.join(fixture, 'node_modules'), 'junction');
    const fixturePkg = await readJson(path.join(fixture, 'package.json'));
    fixturePkg.version = version;
    fixturePkg.build = { nsis: fixturePkg.build.nsis };
    await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify(fixturePkg, null, 2));
    await check('native-boundaries', ['--test', path.join(fixture, 'tests/native-payload.test.cjs')]);
    const transaction = path.join(work, 'transaction');
    await check('install-update-recovery', [path.join(fixture, 'e2e/installer-update.cjs'), transaction]);
    const transactionReport = path.join(transaction, 'report.json');
    await check('notice-installation', [path.join(fixture, 'e2e/installer-notice-compatibility.cjs'), transactionReport]);
    await check('bootstrap-installation-compatibility', [path.join(fixture, 'e2e/installer-bootstrap-compatibility.cjs'), transactionReport]);
    await check('static-text-installation', [path.join(fixture, 'e2e/installer-static-text-compatibility.cjs'), transactionReport]);
    await check('runtime-rejection-rollback', [path.join(fixture, 'e2e/installer-payload-rejection.cjs'), transactionReport]);
    const candidate = path.join(payload, 'candidate.json'), copied = path.join(payload, path.basename(installer));
    await fs.copyFile(installer, copied);
    assert.deepEqual(await fingerprint(copied), { size: artifact.size, sha256: artifact.sha256 });
    await fs.writeFile(candidate, JSON.stringify({ version, installer: copied, source: client, sha256: artifact.sha256,
      bytes: artifact.size, payloadVerified: false, published: false }));
    await check('delivered-payload', [path.join(fixture, 'e2e/installer-candidate-payload.cjs'), candidate]);
    await check('delivered-runtime', [path.join(fixture, 'e2e/installer-runtime-resources.cjs'), candidate]);
    await check('packaged-runner-lifecycle', [path.join(fixture, 'e2e/packaged-runner.cjs'), candidate, 'lifecycle']);
    await check('packaged-runner-task', [path.join(fixture, 'e2e/packaged-runner.cjs'), candidate, 'task']);
    await check('delivered-notices', [path.join(fixture, 'e2e/installer-all-notices.cjs'), candidate]);
    const delivered = await readJson(path.join(payload, 'payload-result.json'));
    await check('restored-payload', [path.join(delivered.extracted, '.soduwork-verify.cjs'), delivered.extracted,
      path.join(payload, 'restored-payload.json')]);
    report.evidence = { transaction: transactionReport, payload: delivered,
      runtime: await readJson(path.join(payload, 'runtime-resource-regression.json')),
      notices: await readJson(path.join(payload, 'all-notices-regression.json')) };
    assert.deepEqual(await fingerprint(installer), { size: artifact.size, sha256: artifact.sha256 }, 'Deliverable changed during validation');
    report.ok = true; validateReport(report, artifact, readBuildInputs(client));
  } catch (error) { report.ok = false; report.error = error.message; throw error; }
  finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('Installer compatibility receipt: ' + reportFile);
  }
}
module.exports = { copyFixture };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

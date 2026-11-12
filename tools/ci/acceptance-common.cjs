'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { createWriteStream } = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const contract = require('./release-artifacts.cjs');
const { newer, parseVersion } = require('../../client/main/client-update-contract.js');
function assertUpgradeVersion(previousVersion, candidateVersion) {
  for (const version of [previousVersion, candidateVersion]) {
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(1|[1-9]\d*))?$/, 'Invalid upgrade semantic version');
    assert.ok(parseVersion(version).every(Number.isSafeInteger), 'Invalid upgrade semantic version');
  }
  assert.ok(newer(candidateVersion, previousVersion), 'Upgrade requires a real older version');
}
async function cachedBaseline(output, digest, directory, download) {
  if (!directory) { await download(output); return; }
  await fs.mkdir(directory, { recursive: true });
  const entry = path.join(directory, digest);
  const valid = await contract.fingerprint(entry).then(row => row.sha256 === digest, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (valid) console.log('Baseline download cache: hit');
  else {
    console.log('Baseline download cache: miss');
    const partial = path.join(directory, digest + '.' + require('node:crypto').randomUUID() + '.partial');
    try {
      await download(partial);
      assert.equal((await contract.fingerprint(partial)).sha256, digest, 'Old installer differs from pinned baseline');
      // Publish only complete, verified content; failed downloads must not corrupt reusable entries.
      try { await fs.rename(partial, entry); }
      catch (error) {
        // Concurrent Windows readers may delay replacement; reuse another writer's entry only after matching its digest.
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) ||
            (await contract.fingerprint(entry)).sha256 !== digest) throw error;
      }
    } finally { await fs.rm(partial, { force: true }); }
  }
  await fs.copyFile(entry, output);
}
async function run(file, args, options = {}) {
  const { log, timeout = 15 * 60 * 1000, ...rest } = options;
  const sink = log ? createWriteStream(log, { flags: 'a' }) : null;
  let failed = false;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(file, args, { windowsHide: true, ...rest });
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid) {
          require('node:child_process').spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, stdio: 'ignore', timeout: 30000 });
        } else child.kill('SIGKILL');
        reject(Error(`${path.basename(file)} timed out; see ${log || 'job log'}`));
      }, timeout);
      let stdout = '';
      child.stdout.on('data', bytes => { if (!log) stdout += bytes; if (sink) sink.write(bytes); else process.stdout.write(bytes); });
      child.stderr.on('data', bytes => { if (sink) sink.write(bytes); else process.stderr.write(bytes); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        code === 0 ? resolve(stdout.trim()) : reject(Error(`${path.basename(file)} exited ${code}; see ${log || 'job log'}`));
      });
    });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (sink) {
      await new Promise(resolve => sink.end(resolve));
      if (failed) {
        // Preserve the child failure in the job log as well as its artifact.
        // Read only a bounded tail, even for verbose installer output.
        try {
          const file = await fs.open(log, 'r');
          try {
            const { size } = await file.stat();
            const buffer = Buffer.alloc(Math.min(size, 16384));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
            process.stderr.write(buffer.subarray(0, bytesRead));
          } finally { await file.close(); }
        } catch (error) { console.error('Cannot read acceptance diagnostics:', error.message); }
      }
    }
  }
}
async function baseline(key, directory, { file = process.env.SODUWORK_ACCEPT_BASELINES_FILE, productName,
  candidateVersion = require('../../client/package.json').version,
  cacheDirectory = process.env.SODUWORK_DOWNLOAD_CACHE || (process.env.CI ?
    path.join(require('node:os').homedir(), '.cache/soduwork-ci/downloads') : null) } = {}) {
  assert.ok(file, 'Configure a baseline file with pinned old installers');
  const config = await contract.read(file);
  const item = config[key];
  assert.ok(item && /^\d+\.\d+\.\d+$/.test(item.version), 'Missing baseline: ' + key);
  assertUpgradeVersion(item.version, candidateVersion);
  if (productName) assert.equal(item.productName, productName, 'Cross-brand installation is not an upgrade');
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
  if (item.size !== undefined) assert.ok(Number.isSafeInteger(item.size) && item.size > 0, 'Invalid baseline size');
  const suffix = item.format || key.split('-').slice(2).join('-');
  assert.ok(['exe', 'deb', 'rpm', 'tar.gz', 'dmg', 'zip'].includes(suffix));
  const output = path.join(directory, 'baseline-' + key + '.' + suffix);
  if (item.path) await fs.copyFile(item.path, output);
  else await cachedBaseline(output, item.sha256, cacheDirectory, async target => {
    const url = new URL(item.url);
    assert.ok(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password);
    const options = { redirect: 'error', signal: AbortSignal.timeout(10 * 60 * 1000) };
    let response = await fetch(url, options);
    if (response.status === 404 && item.fallbackUrl) {
      // Bootstrap against the old Hub before fixed-version downloads are deployed.
      // The mandatory SHA-256 below rejects a newer latest download immediately.
      const fallback = new URL(item.fallbackUrl);
      assert.ok(fallback.protocol === 'https:' && fallback.origin === url.origin &&
        !fallback.username && !fallback.password && !fallback.search && !fallback.hash);
      await response.body?.cancel();
      response = await fetch(fallback, options);
    }
    assert.ok(response.ok, 'Baseline download failed: HTTP ' + response.status);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { flags: 'wx' }));
  });
  const actual = await contract.fingerprint(output);
  assert.equal(actual.sha256, item.sha256, 'Old installer differs from pinned baseline');
  if (item.size !== undefined) assert.equal(actual.size, item.size, 'Old installer size differs from pinned baseline');
  return { ...item, path: output };
}
function soduworkBaseline(key, directory) {
  return baseline(key, directory, { file: process.env.SODUWORK_ACCEPT_BASELINES_FILE ||
    path.join(__dirname, 'soduwork-acceptance-baselines.json'), productName: 'SoduWork' });
}
module.exports = { run, baseline, soduworkBaseline, assertUpgradeVersion };

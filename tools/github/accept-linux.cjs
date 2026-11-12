'use strict';
// Disposable containers only; public distro repositories and pinned release baselines.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const contract = require('../ci/release-artifacts.cjs');
const { run, soduworkBaseline } = require('../ci/acceptance-common.cjs');
const scenarios = [
  ['ubuntu22-deb', 'ubuntu:22.04', 'deb', 'deb'],
  ['ubuntu24-deb', 'ubuntu:24.04', 'deb', 'deb'],
  ['rocky9-rpm', 'rockylinux:9', 'rpm', 'rpm'],
  ['ubuntu22-tgz', 'ubuntu:22.04', 'tar.gz', 'tgz'],
];
async function main() {
  assert.equal(process.platform, 'linux');
  const record = await contract.verify('linux');
  const packages = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-public-accept-'));
  const checks = [];
  try {
    const old = {};
    for (const item of record.artifacts) {
      await fs.copyFile(path.join(contract.dist, item.name), path.join(packages, item.name));
      old[item.format] = await soduworkBaseline('linux-x64-' + item.format, packages);
    }
    for (const [name, image, format, kind] of scenarios) {
      const item = record.artifacts.find(row => row.format === format), previous = old[format];
      const output = path.join(contract.root, 'release-evidence/linux', name);
      await fs.mkdir(output, { recursive: true });
      const container = 'soduwork-public-' + require('node:crypto').randomUUID();
      let created = false;
      try {
        await run('docker', ['create', '--name', container, '--cpus', '2', '--memory', '4g', '--pids-limit', '512',
          '-v', packages + ':/pkg:ro', '-v', path.join(contract.root, 'tools') + ':/checks:ro',
          '-v', output + ':/evidence', '-e', 'SODUWORK_ACCEPT_UID=' + (os.userInfo().uid || 12001), image, 'sleep', 'infinity']);
        created = true;
        await run('docker', ['start', container]);
        const args = [kind, '/pkg/' + item.name, record.version, previous ? '/pkg/' + path.basename(previous.path) : '-', previous ? previous.version : '-'];
        await run('docker', ['exec', container, 'bash', '/checks/github/linux-installed-check.sh', 'prepare', ...args]);
        await run('docker', ['network', 'disconnect', 'bridge', container]);
        await run('docker', ['exec', container, 'bash', '/checks/github/linux-installed-check.sh', 'verify', ...args]);
        const result = await contract.read(path.join(output, 'result.json'));
        assert.equal(result.ok, true); assert.equal(result.version, record.version);
        assert.equal(result.upgraded, !!previous); assert.equal(result.oldVersion, previous ? previous.version : '');
        if (!previous) assert.equal(result.reinstalled, true);
        assert.equal(result.nodeShimExecutable, true);
        checks.push({ name, ok: true, upgraded: !!previous, reinstalled: !previous, oldVersion: previous ? previous.version : '' });
      } finally { if (created) await run('docker', ['rm', '-f', container]); }
    }
    await contract.acceptance('linux', checks, ['Disposable Xvfb containers with GNOME Keyring; no desktop login, Wayland or polkit interaction.',
      ...(checks.some(row => !row.upgraded) ? ['First SoduWork release: fresh install, restart and reinstall preserve data; SoduWork Global migration is not supported.'] : [])]);
  } finally { await fs.rm(packages, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

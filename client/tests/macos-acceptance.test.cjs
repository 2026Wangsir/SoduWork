'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const repo = path.resolve(__dirname, '../..');

test('Mac fresh, old and upgrade installs use separate cleaned DMG mounts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-mac-acceptance-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const version = '9.9.1';
  const distribution = { productName: 'SoduWork', appId: 'com.soduwork.app' };
  const record = { version, artifacts: ['arm64', 'x64'].map(arch =>
    ({ name: `SoduWork-9.9.1-mac-${arch}.dmg`, arch, format: 'dmg' })) };
  const mounts = [], smoke = [], errors = [], profiles = new Map();
  let checks;
  async function run(file, args) {
    if (file === 'hdiutil') {
      if (args[0] === 'attach') {
        const mount = args[args.indexOf('-mountpoint') + 1];
        const product = distribution.productName;
        await fs.mkdir(path.join(mount, product + '.app', 'Contents'), { recursive: true });
        mounts.push(mount);
      } else if (args[0] === 'detach') {
        // hdiutil detaches the volume but leaves the user-created mount directory.
        for (const name of await fs.readdir(args[1]))
          await fs.rm(path.join(args[1], name), { recursive: true });
        assert.deepEqual(await fs.readdir(args[1]), []);
      } else assert.equal(args[0], 'verify');
    } else if (file === 'ditto') {
      await fs.cp(args[0], args[1], { recursive: true });
    } else if (file === '/usr/libexec/PlistBuddy') {
      if (args[1] === 'Print :CFBundleIdentifier') return distribution.appId;
      return path.basename(path.dirname(path.dirname(args[2])), '.app');
    } else if (file === 'lipo') {
      return args[1].includes('arm64-dmg') ? 'arm64' : 'x86_64';
    } else if (file === process.execPath) {
      const profile = args[3], mode = args[6];
      assert.ok(path.basename(profile).startsWith('soduwork-acceptance-profile-'));
      profiles.set(path.basename(args[4]), profile);
      await fs.mkdir(profile, { recursive: true });
      const sentinel = path.join(profile, 'acceptance-sentinel.txt');
      if (mode === 'write') await fs.writeFile(sentinel, 'preserve-install-acceptance-data');
      else assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve-install-acceptance-data');
      smoke.push([path.basename(args[4]), args[5], mode]);
    } else assert.equal(file, 'codesign');
    return '';
  }
  const state = { platform: 'darwin', execPath: process.execPath, env: {} };
  const sandbox = {
    __dirname: path.join(repo, 'tools/ci'), process: state, console: { error: error => errors.push(error) },
    module: { exports: {} },
    require(name) {
      if (name === 'node:os') return { tmpdir: () => root };
      if (name === './release-artifacts.cjs') return { root, dist: root, evidence: path.join(root, 'release-evidence'),
        distribution, verify: async () => record,
        acceptance: async (platform, result) => { assert.equal(platform, 'macos'); checks = result; } };
      if (name === './acceptance-common.cjs') return { run,
        soduworkBaseline: async (_key, current) =>
          ({ version: '9.9.0', productName: 'SoduWork', path: path.join(current, 'baseline.dmg') }) };
      if (name === './macos-signature.cjs') return require('../../tools/ci/macos-signature.cjs');
      return require(name);
    },
  };
  sandbox.require.main = sandbox.module;
  await vm.runInNewContext(await fs.readFile(path.join(repo, 'tools/ci/accept-macos.cjs'), 'utf8'), sandbox);
  assert.deepEqual(errors, []); assert.equal(state.exitCode, undefined);
  assert.equal(mounts.length, 6); assert.equal(new Set(mounts).size, 6);
  assert.deepEqual(smoke, ['arm64', 'x64'].flatMap(arch => [
    [`${arch}-dmg-fresh.json`, version, 'write'], [`${arch}-dmg-restart.json`, version, 'read'],
    [`${arch}-dmg-old.json`, '9.9.0', 'write'], [`${arch}-dmg-upgrade.json`, version, 'read'],
  ]));
  for (const arch of ['arm64', 'x64']) {
    const get = label => profiles.get(`${arch}-dmg-${label}.json`);
    assert.equal(get('fresh'), get('restart'));
    assert.equal(get('old'), get('upgrade'));
    assert.notEqual(get('fresh'), get('old'), 'Upgrade must read the original old-version profile');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(checks)), ['arm64', 'x64'].map(arch =>
    ({ name: arch + '-dmg', ok: true, oldVersion: '9.9.0', oldSignature: { verified: true, policy: 'strict' } })));
  assert.deepEqual(await fs.readdir(root), ['release-evidence']);
});

 test('first Mac release contract skips only its explicit version and platform baselines', async t => {
  const { baseline } = require('../../tools/ci/acceptance-common.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-first-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'baselines.json');
  await fs.writeFile(file, JSON.stringify({ firstRelease: {
    version: '1.13.15', keys: ['macos-arm64-dmg', 'windows-x64-exe'], excludedProduct: 'SoduWork Global',
  } }));
  const options = { file, productName: 'SoduWork', candidateVersion: '1.13.15' };
  assert.equal(await baseline('macos-arm64-dmg', root, options), null);
  await assert.rejects(baseline('windows-x64-exe', root, options), /Missing baseline/);
  await assert.rejects(baseline('macos-arm64-dmg', root, { ...options, candidateVersion: '1.13.16' }), /Missing baseline/);
 });

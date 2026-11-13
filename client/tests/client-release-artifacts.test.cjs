'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const repo = path.resolve(__dirname, '../..');

const internalCiFiles = ['.gitlab-ci.yml', 'tools/ci/client-release.gitlab.yml'];
function internalCiSkip(root) {
  // Missing CI in a normal checkout remains an error. Only an explicit source
  // profile that excludes both internal contracts can omit these tests.
  if (internalCiFiles.some(name => fs.existsSync(path.join(root, name)))) return false;
  let profile;
  try { profile = JSON.parse(fs.readFileSync(path.join(root, 'tools/distribution/PUBLIC-SOURCE.json'), 'utf8')); }
  catch { return false; }
  if (!profile || profile.schema !== 1 || profile.id !== 'opensource-v1' || typeof profile.sourceOnly !== 'boolean' ||
      !Array.isArray(profile.excludedFiles) || !profile.excludedFiles.every(name => typeof name === 'string') ||
      !profile.excludedFiles.includes('.gitlab-ci.yml') || !Array.isArray(profile.buildChecks) ||
      !profile.buildChecks.every(name => typeof name === 'string') ||
      profile.buildChecks.includes('client-release.gitlab.yml') ||
      !fs.existsSync(path.join(root, 'client/tests/client-release-artifacts.test.cjs'))) return false;
  return 'Public source snapshot excludes company GitLab configuration; generic release artifact checks still run.';
}

function profileFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-ci-boundary-'));
  fs.mkdirSync(path.join(root, 'tools/distribution'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'client/tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'client/tests/client-release-artifacts.test.cjs'), '// fixture');
  const profile = { schema: 1, id: 'opensource-v1', sourceOnly: true,
    excludedFiles: ['.gitlab-ci.yml'], buildChecks: [] };
  const write = value => fs.writeFileSync(path.join(root, 'tools/distribution/PUBLIC-SOURCE.json'), JSON.stringify(value));
  return { root, profile, write };
}

test('missing internal CI configuration in a normal checkout cannot silently skip contracts', t => {
  const f = profileFixture(t);
  assert.equal(internalCiSkip(f.root), false);
  fs.writeFileSync(path.join(f.root, 'tools/distribution/PUBLIC-SOURCE.json'), '{malformed');
  assert.equal(internalCiSkip(f.root), false);
  for (const value of [null, {}, { ...f.profile, schema: 2 }, { ...f.profile, sourceOnly: 'true' },
    { ...f.profile, id: 'unrelated profile' }, { ...f.profile, excludedFiles: [] },
    { ...f.profile, excludedFiles: [null] }, { ...f.profile, buildChecks: null },
    { ...f.profile, buildChecks: ['client-release.gitlab.yml'] }]) {
    f.write(value);
    assert.equal(internalCiSkip(f.root), false);
  }
});

test('only a declared source snapshot without either internal CI file skips company contracts', t => {
  const f = profileFixture(t); f.write(f.profile);
  assert.match(internalCiSkip(f.root), /Public source snapshot/);
  for (const name of internalCiFiles) {
    const file = path.join(f.root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '# fixture');
    assert.equal(internalCiSkip(f.root), false, 'partial or complete CI stays enforced');
    fs.unlinkSync(file);
  }
  assert.match(internalCiSkip(f.root), /Public source snapshot/);
});

function fixture(t, version = '9.9.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-release-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'tools/ci'), dist = path.join(root, 'client/dist');
  fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(dist, { recursive: true });
  for (const name of ['release-artifacts.cjs', 'publish-client.cjs', 'merge-macos.cjs', 'soduwork-acceptance-baselines.json'])
    fs.copyFileSync(path.join(repo, 'tools/ci', name), path.join(scripts, name));
  fs.writeFileSync(path.join(root, 'client/package.json'), JSON.stringify({ version, productName: 'SoduWork' }));
  const bytes = Buffer.alloc(1024 * 1024 + 7, 12);
  const names = {
    windows: [`SoduWork-${version}-Setup.exe`],
    linux: ['deb', 'rpm', 'tar.gz'].map(ext => `SoduWork-${version}-linux.${ext}`),
    macos: ['arm64', 'x64'].map(arch => `SoduWork-${version}-mac-${arch}.dmg`),
  };
  for (const name of Object.values(names).flat()) fs.writeFileSync(path.join(dist, name), bytes);
  function execute(args, success = true) {
    const result = spawnSync(process.execPath, args, {
      cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '42',
        CI_JOB_ID: '24', SODUWORK_CLIENT_ARTIFACT_PREFIX: 'SoduWork' },
    });
    assert.ifError(result.error);
    if (success) assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0, result.stdout);
    return result;
  }
  function run(command, platform, prefix = 'SoduWork', success = true, arch) {
    return execute(['-e', 'process.env.SODUWORK_CLIENT_ARTIFACT_PREFIX=' + JSON.stringify(prefix) + ';' +
      'require(' + JSON.stringify(path.join(scripts, 'release-artifacts.cjs')) + ')[' + JSON.stringify(command) + '](' +
      JSON.stringify(platform) + ',' + JSON.stringify(arch) + ').catch(e=>{console.error(e);process.exitCode=1})'], success);
  }
  function shard(arch) {
    run('inventory', 'macos', 'SoduWork', true, arch);
    execute(['-e', 'require(' + JSON.stringify(path.join(scripts, 'release-artifacts.cjs')) + ')' +
      '.acceptance("macos",[{name:' + JSON.stringify(arch + '-dmg') + ',ok:true}],[], ' + JSON.stringify(arch) +
      ').catch(e=>{console.error(e);process.exitCode=1})']);
  }
  function acceptance(platform, checks, success = true) {
    return execute(['-e', 'require(' + JSON.stringify(path.join(scripts, 'release-artifacts.cjs')) + ')' +
      '.acceptance(' + JSON.stringify(platform) + ',' + JSON.stringify(checks) + ')' +
      '.catch(e=>{console.error(e);process.exitCode=1})'], success);
  }
  return { root, dist, names, bytes, run, shard, acceptance,
    merge: success => execute([path.join(scripts, 'merge-macos.cjs')], success) };
}

for (const platform of ['windows', 'linux', 'macos']) {
  test(`${platform} inventory and verification only accept original SoduWork files`, t => {
    const f = fixture(t);
    // A reused workspace may still contain ZIPs from an earlier Mac build.
    if (platform === 'macos') for (const arch of ['arm64', 'x64'])
      fs.writeFileSync(path.join(f.dist, `SoduWork-9.9.1-mac-${arch}.zip`), f.bytes);
    f.run('inventory', platform);
    const record = JSON.parse(fs.readFileSync(path.join(f.dist, platform + '-build.json')));
    assert.equal(record.artifacts.length, f.names[platform].length);
    for (const item of record.artifacts) {
      assert.match(item.name, /^SoduWork-/);
      assert.deepEqual(fs.readFileSync(path.join(f.dist, item.name)), f.bytes);
      assert.equal(fs.existsSync(path.join(f.dist, item.name)), true);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'client/package.json'))).productName, 'SoduWork');
    f.run('inventory', platform); // Exact retries keep immutable bytes.
    f.run('verify', platform);
    if (platform === 'macos') {
      const manifest = path.join(f.dist, 'macos-build.json');
      record.artifacts.push({ ...record.artifacts[0], name: 'SoduWork-9.9.1-mac-arm64.zip', format: 'zip' });
      fs.writeFileSync(manifest, JSON.stringify(record));
      f.run('verify', platform, 'OtherBrand', false);
      f.run('inventory', platform);
    }
    f.run('inventory', platform, 'OtherBrand', false);
    f.run('verify', platform, 'OtherBrand', false);
    fs.appendFileSync(path.join(f.dist, record.artifacts[0].name), 'tampered');
    f.run('verify', platform, 'OtherBrand', false);
  });
}

test('default release preserves the new brand and rejects arbitrary artifact prefixes', t => {
  const f = fixture(t);
  f.run('inventory', 'windows');
  const record = JSON.parse(fs.readFileSync(path.join(f.dist, 'windows-build.json')));
  assert.equal(record.artifacts[0].name, 'SoduWork-9.9.1-Setup.exe');
  assert.equal(fs.existsSync(path.join(f.dist, 'SoduWork-9.9.1-Setup.exe')), true);
  f.run('inventory', 'windows', '../outside', false);
});

test('Mac shards cannot substitute for a complete publishable build and acceptance', t => {
  const f = fixture(t); f.shard('x64');
  f.run('verify', 'macos', 'SoduWork', false);
  f.merge(false);
  fs.copyFileSync(path.join(f.dist, 'macos-x64-build.json'), path.join(f.dist, 'macos-build.json'));
  f.run('verify', 'macos', 'SoduWork', false);
  f.shard('arm64'); f.merge(true); f.run('verify', 'macos');
  const record = JSON.parse(fs.readFileSync(path.join(f.dist, 'macos-build.json')));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'release-evidence/macos/acceptance.json')));
  assert.equal(record.kind, 'soduwork-client-build');
  assert.deepEqual(record.shards.map(item => item.arch), ['arm64', 'x64']);
  assert.equal(receipt.kind, 'soduwork-native-install-acceptance');
  assert.deepEqual(receipt.artifacts, record.artifacts);
  assert.deepEqual(receipt.checks.map(item => item.name), ['arm64-dmg', 'x64-dmg']);
});

for (const corruption of ['commit', 'pipeline', 'bytes', 'receipt', 'failed-check']) {
  test('Mac merge rejects shard corruption: ' + corruption, t => {
    const f = fixture(t); f.shard('arm64'); f.shard('x64');
    const file = path.join(f.root, corruption === 'receipt' || corruption === 'failed-check'
      ? 'release-evidence/macos/x64/acceptance.json' : 'client/dist/macos-x64-build.json');
    const value = JSON.parse(fs.readFileSync(file));
    if (corruption === 'commit') value.sourceCommit = 'b'.repeat(40);
    if (corruption === 'pipeline') value.pipelineId = 'other';
    if (corruption === 'receipt') value.artifacts[0].sha256 = '0'.repeat(64);
    if (corruption === 'failed-check') value.checks[0].ok = false;
    fs.writeFileSync(file, JSON.stringify(value));
    if (corruption === 'bytes') fs.appendFileSync(path.join(f.dist, f.names.macos[1]), 'changed');
    f.merge(false);
    assert.equal(fs.existsSync(path.join(f.dist, 'macos-build.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'release-evidence/macos/acceptance.json')), false);
  });
}

test('Mac CI pins each architecture to its native runner and waits for both acceptance shards',
  { skip: internalCiSkip(repo) }, () => {
  const build = yaml.load(fs.readFileSync(path.join(repo, '.gitlab-ci.yml'), 'utf8'));
  const release = yaml.load(fs.readFileSync(path.join(repo, 'tools/ci/client-release.gitlab.yml'), 'utf8'));
  for (const arch of ['arm64', 'x64']) {
    const tags = [arch === 'x64' ? 'soduwork-mac-x64' : 'soduwork-mac'];
    assert.deepEqual(build['package:macos:' + arch].tags, tags);
    assert.equal(build['package:macos:' + arch].variables.SODUWORK_MACOS_ARCH, arch);
  }
  const script = build['.package-macos'].script;
  assert.ok(script.indexOf('node tools/ci/accept-macos.cjs "$SODUWORK_MACOS_ARCH"') >
    script.indexOf('node ../tools/ci/release-artifacts.cjs inventory macos "$SODUWORK_MACOS_ARCH"'));
  assert.ok(build['.package-macos'].artifacts.paths.includes('release-evidence/macos/'));
  assert.deepEqual(release['accept:macos'].needs.map(item => item.job).sort(),
    ['package:macos:arm64', 'package:macos:x64']);
  assert.deepEqual(release['publish:macos'].needs, [{ job: 'accept:macos', artifacts: true }]);
  assert.match(release['publish:macos'].rules[0].if, /CI_COMMIT_REF_PROTECTED/);
});

test('release jobs receive scoped production credentials only for preparation and deployment',
  { skip: internalCiSkip(repo) }, () => {
  const config = yaml.load(fs.readFileSync(path.join(repo, 'tools/ci/client-release.gitlab.yml'), 'utf8'));
  assert.deepEqual(config['.soduwork-publish'].environment, { name: 'production/client', action: 'prepare' });
  for (const platform of ['windows', 'linux', 'macos']) {
    const parents = config['publish:' + platform].extends;
    assert.ok([].concat(parents).includes('.soduwork-publish'));
  }
  assert.equal(config['publish:enable'].environment.name, 'production/client');
  assert.match(config['publish:enable'].rules[0].if, /client-v/);
  assert.match(config['publish:enable'].rules[0].if, /CI_COMMIT_REF_PROTECTED/);
  assert.equal(config['publish:enable'].rules[0].when, undefined);
  for (const platform of ['windows', 'linux', 'macos']) assert.equal(config['accept:' + platform].environment, undefined);
});

test('first Windows release writes a real receipt after fresh repair and compatibility checks', t => {
  const f = fixture(t, '1.13.15');
  f.run('inventory', 'windows');
  const checks = [{ name: 'fresh-repair', ok: true, oldVersion: '1.13.15' }, { name: 'compatibility', ok: true }];
  const receiptFile = path.join(f.root, 'release-evidence/windows/acceptance.json');
  for (const incomplete of [checks.slice(0, 1), checks.slice(1),
    [checks[0], { ...checks[1], ok: false }],
    [...checks, { name: 'previous-brand-upgrade', ok: true }]]) {
    f.acceptance('windows', incomplete, false);
    assert.equal(fs.existsSync(receiptFile), false);
  }
  f.acceptance('windows', checks);
  const record = JSON.parse(fs.readFileSync(path.join(f.dist, 'windows-build.json')));
  const receipt = JSON.parse(fs.readFileSync(receiptFile));
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.artifacts, record.artifacts);
  assert.deepEqual(receipt.checks, checks);
});

test('Windows first-release exception requires the committed platform and product contract', t => {
  const f = fixture(t, '1.13.15');
  f.run('inventory', 'windows');
  const file = path.join(f.root, 'tools/ci/soduwork-acceptance-baselines.json');
  const baselines = JSON.parse(fs.readFileSync(file));
  for (const firstRelease of [undefined,
    { ...baselines.firstRelease, keys: ['macos-x64-dmg'] },
    { ...baselines.firstRelease, excludedProduct: 'SoduWork' },
    { ...baselines.firstRelease, version: '1.13.14' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...baselines, firstRelease }));
    f.acceptance('windows', ['fresh-repair', 'compatibility'].map(name => ({ name, ok: true })), false);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'release-evidence/windows/acceptance.json')), false);
});

for (const platform of ['linux', 'macos']) {
  test(`first ${platform} release receipt accepts reinstall evidence without claiming an upgrade`, t => {
    const f = fixture(t, '1.13.15');
    f.run('inventory', platform);
    const names = platform === 'linux' ? ['ubuntu22-deb', 'ubuntu24-deb', 'rocky9-rpm', 'ubuntu22-tgz']
      : ['arm64-dmg', 'x64-dmg'];
    const checks = names.map(name => ({ name, ok: true, reinstalled: true, upgraded: false, oldVersion: '',
      ...(platform === 'macos' ? { freshInstalled: true, restarted: true, uninstalled: true, userDataPreserved: true } : {}) }));
    f.acceptance(platform, checks);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'release-evidence', platform, 'acceptance.json')));
    assert.deepEqual(receipt.checks, checks);
    assert.equal(receipt.ok, true);
  });
}

for (const version of [undefined, '1.13.14', '1.13.16', '9.9.1']) {
  test(`Windows acceptance ${version ?? 'without a version'} requires a SoduWork upgrade`, () => {
    const contract = require('../../tools/ci/release-artifacts.cjs');
    const record = { platform: 'windows', version, sourceCommit: 'a'.repeat(40), pipelineId: '42', artifacts: [] };
    const receipt = { schema: 1, kind: 'soduwork-native-install-acceptance', ok: true, ...record,
      checks: ['fresh-repair', 'compatibility'].map(name => ({ name, ok: true })) };
    assert.throws(() => contract.validateAcceptance(record, receipt));
    receipt.checks.push({ name: 'previous-brand-upgrade', ok: true });
    assert.throws(() => contract.validateAcceptance(record, receipt));
    receipt.checks.at(-1).name = 'soduwork-upgrade';
    assert.equal(contract.validateAcceptance(record, receipt), receipt);
    receipt.checks.at(-1).ok = false;
    assert.throws(() => contract.validateAcceptance(record, receipt));
  });
}

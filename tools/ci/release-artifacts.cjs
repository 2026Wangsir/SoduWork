'use strict';
// One inventory follows the exact deliverables through acceptance and upload.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'client/dist');
const version = require('../../client/package.json').version;
const { firstRelease } = require('./soduwork-acceptance-baselines.json');
const read = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
};
async function fingerprint(file) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest('hex') };
}
function artifactPrefix() {
  const value = process.env.SODUWORK_CLIENT_ARTIFACT_PREFIX || 'SoduWork';
  assert.equal(value, 'SoduWork', 'New releases must use the SoduWork artifact prefix');
  return value;
}
function expected(platform) { return selected(platform); }
function selected(platform, arch) {
  if (arch !== undefined) assert.ok(platform === 'macos' && ['arm64', 'x64'].includes(arch), 'Invalid Mac build shard');
  const stem = artifactPrefix() + '-' + version;
  if (platform === 'windows') return [{ name: stem + '-Setup.exe', platform: 'win32', arch: 'x64', format: 'exe' }];
  if (platform === 'linux') return ['deb', 'rpm', 'tar.gz'].map(format =>
    ({ name: stem + '-linux.' + format, platform: 'linux', arch: 'x64', format }));
  assert.equal(platform, 'macos', 'Unknown release platform');
  return (arch === undefined ? ['arm64', 'x64'] : [arch]).map(arch =>
    ({ name: stem + '-mac-' + arch + '.dmg', platform: 'darwin', arch, format: 'dmg' }));
}
const manifest = (platform, arch) => path.join(dist, platform + (arch === undefined ? '' : '-' + arch) + '-build.json');
async function inventory(platform, arch) {
  assert.match(process.env.CI_COMMIT_SHA || '', /^[a-f0-9]{40}$/, 'Build inventory requires the CI commit');
  const artifacts = [];
  for (const item of selected(platform, arch)) {
    const target = path.join(dist, item.name);
    const actual = await fingerprint(target);
    assert.ok(actual.size >= 1024 * 1024, 'Empty or invalid installer: ' + item.name);
    artifacts.push({ ...item, ...actual });
  }
  const record = { schema: 1, kind: arch === undefined ? 'soduwork-client-build' : 'soduwork-client-build-shard', platform, version,
    sourceCommit: process.env.CI_COMMIT_SHA, pipelineId: process.env.CI_PIPELINE_ID,
    jobId: process.env.CI_JOB_ID, artifacts };
  await write(manifest(platform, arch), record);
  return record;
}
async function verify(platform, arch) {
  const wanted = selected(platform, arch);
  const record = await read(manifest(platform, arch));
  assert.equal(record.schema, 1); assert.equal(record.kind, arch === undefined ? 'soduwork-client-build' : 'soduwork-client-build-shard');
  assert.equal(record.platform, platform); assert.equal(record.version, version);
  assert.equal(record.sourceCommit, process.env.CI_COMMIT_SHA, 'Artifacts came from a different commit');
  assert.equal(String(record.pipelineId), process.env.CI_PIPELINE_ID, 'Artifacts came from a different pipeline');
  assert.deepEqual(record.artifacts.map(({ name, platform, arch, format }) => ({ name, platform, arch, format })), wanted);
  for (const item of record.artifacts) {
    assert.deepEqual(await fingerprint(path.join(dist, item.name)), { size: item.size, sha256: item.sha256 }, 'Artifact changed: ' + item.name);
  }
  return record;
}
function validateAcceptance(record, receipt) {
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.kind, record.kind === 'soduwork-client-build-shard' ? 'soduwork-native-install-acceptance-shard' : 'soduwork-native-install-acceptance');
  assert.equal(receipt.ok, true, 'Native acceptance has not passed');
  assert.equal(receipt.sourceCommit, record.sourceCommit);
  assert.equal(receipt.pipelineId, record.pipelineId);
  assert.deepEqual(receipt.artifacts, record.artifacts, 'Acceptance tested other bytes');
  // Only the committed, version-scoped release contract can omit the Windows
  // upgrade gate. Receipt contents or a runtime baseline override cannot opt out.
  const firstWindowsRelease = record.platform === 'windows' && typeof record.version === 'string' &&
    record.version !== '' && record.version === firstRelease?.version &&
    firstRelease?.excludedProduct === 'SoduWork Global' &&
    Array.isArray(firstRelease.keys) && firstRelease.keys.includes('windows-x64-exe');
  const required = record.platform === 'windows' ? ['fresh-repair', ...(firstWindowsRelease ? [] : ['soduwork-upgrade']), 'compatibility']
    : record.platform === 'linux' ? ['ubuntu22-deb', 'ubuntu24-deb', 'rocky9-rpm', 'ubuntu22-tgz']
      : record.artifacts.map(item => item.arch + '-' + item.format);
  assert.deepEqual(receipt.checks.map(item => item.name).sort(), required.sort());
  for (const check of receipt.checks) assert.equal(check.ok, true, check.name);
  return receipt;
}
async function acceptance(platform, checks, limitations = [], arch) {
  const record = await verify(platform, arch);
  const receipt = { schema: 1, kind: arch === undefined ? 'soduwork-native-install-acceptance' : 'soduwork-native-install-acceptance-shard', ok: true,
    sourceCommit: record.sourceCommit, pipelineId: record.pipelineId, artifacts: record.artifacts,
    checks, limitations, finishedAt: new Date().toISOString() };
  validateAcceptance(record, receipt);
  await write(path.join(root, 'release-evidence', platform, ...(arch === undefined ? [] : [arch]), 'acceptance.json'), receipt);
  return receipt;
}
module.exports = { root, dist, read, write, fingerprint, artifactPrefix, expected, inventory, verify, validateAcceptance, acceptance };
if (require.main === module) {
  const [command, platform, arch] = process.argv.slice(2);
  assert.ok(['inventory', 'verify'].includes(command));
  module.exports[command](platform, arch).then(value => console.log(JSON.stringify(value)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../tools/github/accept-linux.cjs'), 'utf8');
for (const firstRelease of [true, false]) test(`Linux acceptance preserves ${firstRelease ? 'first release reinstall' : 'upgrade'} evidence`, async () => {
  const calls = [], errors = [], version = '1.13.15';
  let checks;
  const state = { platform: 'linux', exitCode: undefined };
  const contract = {
    root: '/fixture', dist: '/fixture/dist',
    verify: async () => ({ version, artifacts: ['deb', 'rpm', 'tar.gz'].map(format => ({ name: `candidate.${format}`, format })) }),
    read: async () => ({ ok: true, version, upgraded: !firstRelease, reinstalled: firstRelease,
      oldVersion: firstRelease ? '' : '1.13.14', nodeShimExecutable: true }),
    acceptance: async (_platform, rows) => { checks = rows; },
  };
  const modules = {
    'node:fs/promises': { mkdtemp: async () => '/fixture/packages', mkdir: async () => {}, copyFile: async () => {}, rm: async () => {} },
    'node:path': path, 'node:os': { tmpdir: () => '/fixture', userInfo: () => ({ uid: 12001 }) },
    'node:assert/strict': assert, 'node:crypto': require('node:crypto'),
    '../ci/release-artifacts.cjs': contract,
    '../ci/acceptance-common.cjs': { run: async (...args) => { calls.push(args); },
      soduworkBaseline: async key => firstRelease ? null : { path: `/fixture/${key}`, version: '1.13.14' } },
  };
  await vm.runInNewContext(source, { process: state, require: name => modules[name],
    console: { error: error => errors.push(error) } });
  assert.deepEqual(errors, []);
  assert.equal(state.exitCode, undefined);
  assert.equal(checks.length, 4);
  for (const row of checks) {
    assert.equal(row.upgraded, !firstRelease);
    assert.equal(row.reinstalled, firstRelease);
  }
  for (const [, args] of calls.filter(([, args]) => args[0] === 'create')) {
    assert.equal(args[args.indexOf('--cap-add') + 1], 'IPC_LOCK');
    assert.equal(args.includes('--privileged'), false);
  }
  const verifies = calls.filter(([, args]) => args[0] === 'exec' && args[4] === 'verify');
  assert.equal(verifies.length, 4);
  for (const [, args] of verifies) {
    assert.equal(args.at(-1), firstRelease ? '-' : '1.13.14');
    if (firstRelease) assert.equal(args.at(-2), '-');
  }
  assert.equal(calls.filter(([, args]) => args[0] === 'rm').length, 4);
});

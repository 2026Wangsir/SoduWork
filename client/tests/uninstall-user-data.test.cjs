'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { cleanUserData } = require('../build/uninstall-resources.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-user-data-test-'));
  const appData = path.join(root, 'account/Roaming'), productName = 'SoduWork isolated test';
  const profile = path.join(appData, productName), external = path.join(root, 'workspace');
  const other = path.join(root, 'other-account/Roaming', productName), custom = path.join(root, 'custom-profile');
  for (const directory of [profile, external, other, custom]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'sentinel'), 'keep');
  }
  const previous = process.env.APPDATA, previousCustom = process.env.SODUWORK_USER_DATA;
  process.env.APPDATA = appData; process.env.SODUWORK_USER_DATA = custom;
  t.after(async () => {
    if (previous === undefined) delete process.env.APPDATA; else process.env.APPDATA = previous;
    if (previousCustom === undefined) delete process.env.SODUWORK_USER_DATA; else process.env.SODUWORK_USER_DATA = previousCustom;
    assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('soduwork-user-data-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function retained() {
    for (const directory of [external, other, custom]) assert.equal(await fs.readFile(path.join(directory, 'sentinel'), 'utf8'), 'keep');
  }
  return { root, appData, productName, profile, external, other, custom, retained };
}

test('explicit cleanup removes only the current account product profile, including nested data', async t => {
  const f = await fixture(t);
  const nested = path.join(f.profile, 'conversations/中文/work.json');
  await fs.mkdir(path.dirname(nested), { recursive: true }); await fs.writeFile(nested, '{}');
  assert.deepEqual(await cleanUserData(f.appData, f.productName), { target: f.profile, removed: true });
  await assert.rejects(fs.access(f.profile), { code: 'ENOENT' });
  await f.retained();
  assert.deepEqual(await cleanUserData(f.appData, f.productName), { target: f.profile, removed: false });
});

test('other accounts, custom locations and path traversal are refused before deletion', async t => {
  const f = await fixture(t);
  for (const directory of [path.dirname(f.other), f.custom, f.root]) {
    await assert.rejects(cleanUserData(directory, f.productName), /current account/);
  }
  for (const name of ['', '.', '..', '../workspace', '..\\workspace', 'C:\\Users', 'name.', 'name ', 'file:stream']) {
    await assert.rejects(cleanUserData(f.appData, name), /one directory component/);
  }
  assert.equal(await fs.readFile(path.join(f.profile, 'sentinel'), 'utf8'), 'keep');
  await f.retained();
});

test('junctions at the profile, in its ancestry and within its tree preserve all data', async t => {
  const f = await fixture(t), kind = process.platform === 'win32' ? 'junction' : 'dir';
  const inside = path.join(f.profile, 'linked-workspace');
  await fs.symlink(f.external, inside, kind);
  await assert.rejects(cleanUserData(f.appData, f.productName), /contains a link/);
  assert.equal(await fs.readFile(path.join(f.profile, 'sentinel'), 'utf8'), 'keep');
  await fs.unlink(inside);
  const linkedName = 'Linked profile'; await fs.symlink(f.external, path.join(f.appData, linkedName), kind);
  await assert.rejects(cleanUserData(f.appData, linkedName), /must not be a link/);
  await fs.unlink(path.join(f.appData, linkedName));
  const linkedParent = path.join(f.root, 'linked-account'); await fs.symlink(path.dirname(f.appData), linkedParent, kind);
  process.env.APPDATA = path.join(linkedParent, 'Roaming');
  await assert.rejects(cleanUserData(process.env.APPDATA, f.productName), /must not be a link/);
  await fs.unlink(linkedParent);
  assert.equal(await fs.readFile(path.join(f.profile, 'sentinel'), 'utf8'), 'keep');
  await f.retained();
});

test('a missing account environment fails closed', async t => {
  const f = await fixture(t); delete process.env.APPDATA;
  await assert.rejects(cleanUserData(f.appData, f.productName), /unavailable/);
  assert.equal(await fs.readFile(path.join(f.profile, 'sentinel'), 'utf8'), 'keep');
  await f.retained();
});

'use strict';
process.noAsar = true;
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const VERSION = /^ns[a-z0-9]+\.tmp$/i;
const RETIRED = /^ns[a-z0-9]+\.tmp-[a-f0-9-]{36}$/i;

async function realDirectory(directory) {
  const stat = await fs.lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Uninstall directory must not be a link');
}
async function regularFile(file) {
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Uninstall marker must be a regular file');
}
async function inspectTree(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), stat = await fs.lstat(file);
    // The following native removal also walks the remaining shallow folders.
    // Refuse all junctions/symlinks before deleting anything, including links
    // outside resources, so it cannot cross the installation's boundary.
    assert.ok(!stat.isSymbolicLink(), 'Uninstall tree contains a link: ' + file);
    if (stat.isDirectory()) await inspectTree(file);
  }
}
async function cleanUserData(appData, productName) {
  assert.ok(typeof appData === 'string' && path.isAbsolute(appData), 'Application data root must be absolute');
  assert.ok(process.env.APPDATA && path.isAbsolute(process.env.APPDATA), 'Current account application data is unavailable');
  assert.equal(path.resolve(appData).toLowerCase(), path.resolve(process.env.APPDATA).toLowerCase(),
    'Cleanup is limited to the current account application data');
  assert.ok(typeof productName === 'string' && productName.length > 0 && productName.length <= 100 &&
    !/[\\/:*?"<>|\x00-\x1f]/.test(productName) && !/[. ]$/.test(productName) && productName !== '.',
  'Application data name must be one directory component');
  const root = path.resolve(appData), target = path.join(root, productName);
  assert.notEqual(path.dirname(root), root, 'Application data cannot be a filesystem root');
  for (let current = root; ; current = path.dirname(current)) {
    await realDirectory(current);
    if (path.dirname(current) === current) break;
  }
  const stat = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return { target, removed: false };
  await realDirectory(target);
  await inspectTree(target);
  await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  return { target, removed: true };
}
async function cleanResources(requestedRoot, executable = process.execPath, ioRoot = requestedRoot, userData) {
  assert.ok(path.isAbsolute(requestedRoot), 'Uninstall root must be absolute');
  const requested = path.resolve(requestedRoot);
  assert.notEqual(path.dirname(requested), requested, 'Cannot uninstall a filesystem root');
  // Accept Windows 8.3 spellings, but never resolve a linked parent into a
  // different tree. Check the entire ancestry before canonicalizing aliases.
  for (let current = requested; ; current = path.dirname(current)) {
    await realDirectory(current);
    if (path.dirname(current) === current) break;
  }
  const canonicalRoot = await fs.realpath(requested);
  assert.ok(path.isAbsolute(ioRoot), 'Uninstall I/O root must be absolute');
  const root = path.resolve(ioRoot);
  for (let current = root; ; current = path.dirname(current)) {
    await realDirectory(current);
    if (path.dirname(current) === current) break;
  }
  assert.equal((await fs.realpath(root)).toLowerCase(), canonicalRoot.toLowerCase(),
    'Uninstall I/O alias must identify the same installation');
  await regularFile(path.join(root, '.soduwork-launcher'));
  const pointer = path.join(root, '.soduwork-active');
  const pointerExists = await fs.lstat(pointer).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
  let active = null;
  if (pointerExists) {
    await regularFile(pointer);
    active = await fs.readFile(pointer, 'utf8');
    assert.match(active, VERSION, 'Invalid installed version pointer');
  }
  const versions = path.join(root, '.soduwork-versions');
  const actualExecutable = await fs.realpath(executable);
  await regularFile(actualExecutable);
  const flatRecovery = path.join(canonicalRoot, 'SoduWork.previous.exe');
  if (actualExecutable.toLowerCase() !== flatRecovery.toLowerCase()) {
    assert.ok(active, 'Cleanup requires an active version or the original recovery executable');
    await realDirectory(versions);
    const activeRoot = path.join(versions, active);
    await realDirectory(activeRoot);
    await regularFile(path.join(activeRoot, '.soduwork-release'));
    assert.equal(path.dirname(actualExecutable).toLowerCase(), (await fs.realpath(activeRoot)).toLowerCase(),
      'Cleanup must run with this installation\'s active Electron executable');
  }

  const targets = [];
  async function addResources(payload) {
    const resources = path.join(payload, 'resources');
    const stat = await fs.lstat(resources).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Resources must be a real directory');
    assert.ok(resources.startsWith(root + path.sep));
    targets.push(resources);
  }
  await addResources(root); // Resources retained from the legacy flat layout.
  for (const [folder, pattern] of [[versions, VERSION], [path.join(root, '.soduwork-retired'), RETIRED]]) {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const entry of entries) if (entry.isDirectory() && pattern.test(entry.name)) {
      await addResources(path.join(folder, entry.name));
    }
  }
  await inspectTree(root);
  // The optional target comes only from the confirmed native wizard. The
  // current-account check never follows a custom SODUWORK_USER_DATA location.
  const removedUserData = userData ? await cleanUserData(userData.appData, userData.productName) : null;
  // Keep the verified native short alias for I/O. Expanding it back to the
  // canonical spelling can hit path limits in Windows filesystem filters even
  // though the same long Unicode resource is accessible through its alias.
  // Keep executable/DLL files for the native uninstaller after this process
  // exits. User profiles are outside these explicitly selected payload trees.
  for (const resources of targets) {
    await realDirectory(path.dirname(resources));
    await realDirectory(resources);
    await fs.rm(resources, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  }
  return { root: canonicalRoot, ioRoot: root, removedResources: targets, removedUserData };
}
module.exports = { cleanResources, cleanUserData };
if (require.main === module) cleanResources(process.argv[2], process.execPath, process.argv[3] || process.argv[2],
  process.argv[4] ? { appData: process.argv[4], productName: process.argv[5] } : undefined).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 2; });

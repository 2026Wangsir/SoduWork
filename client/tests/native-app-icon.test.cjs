'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { create } = require('../main/native-app-icon.cjs');

test('native PNG artwork has complete chunks and valid checksums for strict decoders', () => {
  const zlib = require('node:zlib');
  const files = [path.join(__dirname, '../icon.png'),
    ...fs.readdirSync(path.join(__dirname, '../build/icons')).filter(name => name.endsWith('.png'))
      .map(name => path.join(__dirname, '../build/icons', name))];
  for (const file of files) {
    const png = fs.readFileSync(file);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    let offset = 8, last = '';
    while (offset < png.length) {
      assert.ok(offset + 12 <= png.length, path.basename(file) + ': truncated chunk');
      const length = png.readUInt32BE(offset), end = offset + length + 12;
      assert.ok(end <= png.length, path.basename(file) + ': truncated payload');
      last = png.toString('ascii', offset + 4, offset + 8);
      assert.equal(png.readUInt32BE(end - 4), zlib.crc32(png.subarray(offset + 4, end - 4)),
        path.basename(file) + ': invalid ' + last + ' checksum');
      offset = end;
    }
    assert.equal(last, 'IEND');
  }
});

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, getPath: key => path.join(root, key), getAppPath: () => root,
    setAppUserModelId: id => { app.identity = id; }, whenReady: () => Promise.resolve() });
  fs.copyFileSync(path.join(__dirname, '../icon.ico'), path.join(root, 'icon.ico'));
  fs.copyFileSync(path.join(__dirname, '../icon.png'), path.join(root, 'icon.png'));
  const launcher = path.join(root, 'installed', 'SoduWork.exe');
  const args = { app, root, profile: { appId: 'com.soduwork.test', productName: 'SoduWork Test' },
    platform: 'win32', executable: launcher, launchPath: candidate => candidate || launcher,
    warn: () => {}, ...options };
  return { root, app, args, helper: create(args), launcher };
}

test('native icon is a verified loose copy, stable across starts and repaired if corrupted', t => {
  const { root, helper, args } = fixture(t);
  const target = helper.icon();
  assert.equal(path.dirname(target), path.join(root, 'userData', 'shell-icons'));
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(root, 'icon.ico')));
  assert.equal(create(args).icon(), target);
  fs.writeFileSync(target, 'broken cache');
  assert.equal(create(args).icon(), target);
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(path.join(root, 'icon.ico')));
  fs.appendFileSync(path.join(root, 'icon.ico'), 'updated fixture');
  assert.notEqual(create(args).icon(), target);
  assert.ok(fs.existsSync(target), 'existing pins may still reference the previous icon');
});

test('process identity is set before windows and every window uses the stable launcher and loose icon', async t => {
  const { app, helper, launcher } = fixture(t);
  helper.install();
  assert.equal(app.identity, 'com.soduwork.test');
  for (let index = 0; index < 2; index++) {
    let icon;
    const details = {}, updates = [];
    app.emit('browser-window-created', {}, { setIcon: value => { icon = value; },
      setAppDetails: value => { Object.assign(details, value); updates.push(value); } });
    assert.equal(icon, helper.icon());
    assert.equal(details.appIconPath, icon);
    assert.equal(details.relaunchCommand, '"' + launcher + '"');
    assert.equal(details.appId, app.identity);
    assert.equal(updates[0].appId, undefined, 'icon and relaunch properties must precede the shell refresh');
    assert.deepEqual(updates[1], { appId: app.identity });
  }
});

test('source profiles have separate taskbar identities and never repair installed pins', t => {
  const first = fixture(t), second = fixture(t);
  for (const current of [first, second]) {
    current.app.isPackaged = false;
    current.helper.install();
    assert.match(current.app.identity, /^com\.soduwork\.test\.dev\./);
  }
  assert.notEqual(first.app.identity, second.app.identity);
});

test('macOS and Linux use PNG icons without Windows identity or cache writes', t => {
  for (const platform of ['darwin', 'linux']) {
    const { root, app, helper } = fixture(t, { platform });
    helper.install();
    assert.equal(app.identity, undefined);
    assert.equal(helper.icon(), path.join(root, 'icon.png'));
    assert.equal(fs.existsSync(path.join(root, 'userData')), false);
  }
});

test('macOS applies the product Dock icon after ready and tolerates native failures', async t => {
  let ready;
  const calls = [], warnings = [];
  const { app, helper, root } = fixture(t, { platform: 'darwin', warn: (...args) => warnings.push(args) });
  app.whenReady = () => new Promise(resolve => { ready = resolve; });
  app.dock = { setIcon: file => calls.push(file) };
  helper.install();
  assert.deepEqual(calls, []);
  ready(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [path.join(root, 'icon.png')]);
  app.dock.setIcon = () => { throw Error('Dock unavailable'); };
  helper.install(); ready(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.length, 1);
});

test('pin repair changes only this installation and preserves shortcut targets and arguments', t => {
  const { root, args, launcher } = fixture(t);
  const directory = path.join(root, 'appData', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
  fs.mkdirSync(directory, { recursive: true });
  const shortcuts = {
    'ours.lnk': { target: launcher, icon: 'old.ico', arguments: '--unchanged' },
    'other-install.lnk': { target: path.join(root, 'elsewhere', 'SoduWork.exe'), appUserModelId: args.profile.appId },
    'other-program.lnk': { target: path.join(root, 'installed', 'another.exe') },
  };
  Object.keys(shortcuts).forEach(name => fs.writeFileSync(path.join(directory, name), 'fixture'));
  const writes = [];
  const helper = create({ ...args, shell: {
    readShortcutLink: file => shortcuts[path.basename(file)],
    writeShortcutLink: (file, operation, details) => { writes.push([path.basename(file), operation, details]); return true; },
  } });
  helper.icon(); helper.repairPins();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], ['ours.lnk', 'update', { icon: helper.icon(), iconIndex: 0, appUserModelId: args.profile.appId }]);
});

test('read-only icon cache falls back without preventing a window from opening', t => {
  const { root, args, app } = fixture(t);
  fs.writeFileSync(path.join(root, 'userData'), 'not a directory');
  const helper = create(args); helper.install();
  const details = {};
  app.emit('browser-window-created', {}, { setIcon() {}, setAppDetails: value => { Object.assign(details, value); } });
  assert.equal(details.appIconPath, args.executable);
});

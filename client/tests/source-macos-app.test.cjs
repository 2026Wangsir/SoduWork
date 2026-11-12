'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareSourceApp, icns } = require('../scripts/source-macos-app.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-source-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  const contents = path.dirname(path.dirname(binary));
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(binary, 'fixture executable');
  fs.writeFileSync(path.join(contents, 'Info.plist'), JSON.stringify({ CFBundleName: 'Electron',
    CFBundleDisplayName: 'Electron', CFBundleIdentifier: 'com.github.Electron',
    CFBundleIconFile: 'electron.icns', CFBundleExecutable: 'Electron' }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ productName: 'SoduWork', build: { appId: 'com.soduwork.app' } }));
  fs.cpSync(path.join(__dirname, '../build/icons'), path.join(root, 'build/icons'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../icon.png'), path.join(root, 'icon.png'));
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push([command, args]);
    if (command.endsWith('plutil')) {
      if (args[1] === 'json') return fs.readFileSync(args.at(-1), 'utf8');
      fs.writeFileSync(args[3], options.input);
    }
  };
  return { root, binary, contents, calls, run };
}

test('source bundle has product identity and icon while preserving source execution semantics', t => {
  const f = fixture(t);
  const original = fs.readFileSync(path.join(f.contents, 'Info.plist'));
  const binary = prepareSourceApp(f);
  assert.match(binary, /SoduWork\.app[/\\]Contents[/\\]MacOS[/\\]Electron$/);
  const contents = path.dirname(path.dirname(binary));
  const plist = JSON.parse(fs.readFileSync(path.join(contents, 'Info.plist'), 'utf8'));
  assert.equal(plist.CFBundleDisplayName, 'SoduWork');
  assert.equal(plist.CFBundleName, 'SoduWork');
  assert.match(plist.CFBundleIdentifier, /^com\.soduwork\.app\.source\.[a-f0-9]{16}$/);
  assert.equal(plist.CFBundleExecutable, 'Electron');
  const icon = fs.readFileSync(path.join(contents, 'Resources', plist.CFBundleIconFile));
  assert.equal(icon.toString('ascii', 0, 4), 'icns');
  assert.equal(icon.readUInt32BE(4), icon.length);
  assert.deepEqual(icon, icns(f.root));
  assert.deepEqual(fs.readFileSync(path.join(f.contents, 'Info.plist')), original);
  assert.equal(fs.existsSync(path.join(f.contents, 'Resources', plist.CFBundleIconFile)), false);
  assert.deepEqual(f.calls.slice(-2).map(call => call[1].slice(0, -1)), [
    ['--force', '--deep', '--sign', '-', '--timestamp=none'], ['--verify', '--deep', '--strict']]);
  const count = f.calls.length;
  assert.equal(prepareSourceApp(f), binary);
  assert.equal(f.calls.length, count, 'a complete bundle is reused');
});

test('source bundle cache changes with icon and runtime updates without replacing an active bundle', t => {
  const f = fixture(t), first = prepareSourceApp(f);
  fs.appendFileSync(path.join(f.root, 'icon.png'), 'fixture update');
  const second = prepareSourceApp(f);
  assert.notEqual(second, first);
  fs.appendFileSync(f.binary, 'runtime update');
  const third = prepareSourceApp(f);
  assert.notEqual(third, second);
  assert.ok([first, second, third].every(file => fs.existsSync(file)));
});

test('failed signing leaves no partial cache and retries without changing dependencies', t => {
  const f = fixture(t);
  assert.throws(() => prepareSourceApp({ ...f, run(command, args, options) {
    if (command.endsWith('codesign')) throw Error('Signing fixture failure');
    return f.run(command, args, options);
  } }), /Signing fixture failure/);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.runtime/source-macos')), []);
  assert.equal(fs.readFileSync(f.binary, 'utf8'), 'fixture executable');
  assert.ok(fs.existsSync(prepareSourceApp(f)));
});

test('an unexpected packaged executable cannot change source profile policy', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.contents, 'Info.plist'), JSON.stringify({ CFBundleExecutable: 'SoduWork' }));
  assert.throws(() => prepareSourceApp(f), /Unexpected source Electron executable/);
});

test('concurrent preparations publish one complete bundle and remove temporary copies', t => {
  const f = fixture(t);
  let winning;
  const binary = prepareSourceApp({ ...f, run(command, args, options) {
    const result = f.run(command, args, options);
    if (command.endsWith('codesign') && args[0] === '--verify') winning = prepareSourceApp(f);
    return result;
  } });
  assert.equal(binary, winning);
  assert.equal(fs.readdirSync(path.join(f.root, '.runtime/source-macos')).length, 1);
});

function mockPlatform(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

function competingPublication(t, f, failure) {
  const rename = fs.renameSync;
  const result = { winning: null };
  let publishing = false;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (publishing) return rename(source, target);
    publishing = true;
    result.winning = prepareSourceApp(f);
    throw failure;
  });
  return result;
}

test('Windows EPERM reuses a completed competing bundle and removes the losing copy', t => {
  const f = fixture(t);
  mockPlatform(t, 'win32');
  const failure = Object.assign(Error('Destination directory exists'), { code: 'EPERM' });
  const result = competingPublication(t, f, failure);
  assert.equal(prepareSourceApp(f), result.winning);
  assert.ok(fs.existsSync(result.winning));
  assert.equal(fs.readdirSync(path.join(f.root, '.runtime/source-macos')).length, 1);
});

for (const incomplete of ['missing destination', 'missing receipt', 'wrong digest', 'missing executable']) {
  test(`Windows EPERM preserves the error for a ${incomplete}`, t => {
    const f = fixture(t);
    mockPlatform(t, 'win32');
    const failure = Object.assign(Error('Publication denied'), { code: 'EPERM' });
    t.mock.method(fs, 'renameSync', (source, target) => {
      if (incomplete !== 'missing destination') {
        fs.cpSync(source, target, { recursive: true });
        const receipt = path.join(target, 'source-app.json');
        if (incomplete === 'missing receipt') fs.unlinkSync(receipt);
        if (incomplete === 'wrong digest') fs.writeFileSync(receipt, JSON.stringify({ digest: 'stale' }));
        if (incomplete === 'missing executable') fs.unlinkSync(path.join(target, 'SoduWork.app/Contents/MacOS/Electron'));
      }
      throw failure;
    });
    assert.throws(() => prepareSourceApp(f), error => error === failure);
    assert.equal(fs.readFileSync(f.binary, 'utf8'), 'fixture executable');
    assert.equal(fs.readdirSync(path.join(f.root, '.runtime/source-macos'))
      .filter(name => name.startsWith('.preparing-')).length, 0);
  });
}

for (const [platform, code] of [['darwin', 'EPERM'], ['win32', 'EIO']]) {
  test(`${platform} ${code} is not masked by a completed competing bundle`, t => {
    const f = fixture(t);
    mockPlatform(t, platform);
    const failure = Object.assign(Error('Publication failed'), { code });
    const result = competingPublication(t, f, failure);
    assert.throws(() => prepareSourceApp(f), error => error === failure);
    assert.ok(fs.existsSync(result.winning));
    assert.equal(fs.readdirSync(path.join(f.root, '.runtime/source-macos')).length, 1);
  });
}

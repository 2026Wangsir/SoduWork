'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { command, cleanEnvironment } = require('../scripts/start-client.cjs');
test('source launcher resolves each native Electron layout', () => {
  for (const [platform, name] of [['win32', 'electron.exe'], ['linux', 'electron'], ['darwin', 'Electron.app/Contents/MacOS/Electron']]) {
    assert.equal(command(platform, 'checkout with spaces'), path.join('checkout with spaces', 'node_modules', 'electron', 'dist', name));
  }
});
test('cleans inherited Chromium process handles without changing user configuration', () => {
  const input = { NODE_OPTIONS: '--bad-option', electron_run_as_node: '1', CHROME_CRASHPAD_PIPE_HANDLE: '12',
    PATH: 'existing path', SODUWORK_USER_DATA: 'existing profile', HTTPS_PROXY: 'existing proxy' };
  const result = cleanEnvironment(input);
  assert.deepEqual(result, { PATH: input.PATH, SODUWORK_USER_DATA: input.SODUWORK_USER_DATA, HTTPS_PROXY: input.HTTPS_PROXY });
  assert.equal(input.NODE_OPTIONS, '--bad-option');
});

test('Linux launch preserves desktop detection and explicit display choices without disabling the sandbox', () => {
  const { EventEmitter } = require('node:events');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/start-client.cjs'), 'utf8');
  for (const args of [[], ['--ozone-platform=x11'], ['--ozone-platform=wayland'], ['--ozone-platform', 'headless']]) {
    const env = { PATH: '/fixture/bin', HOME: '/home/fixture', XDG_CURRENT_DESKTOP: 'GNOME',
      XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-fixture', DISPLAY: ':fixture',
      XDG_RUNTIME_DIR: '/run/user/fixture', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/fixture/bus',
      SODUWORK_USER_DATA: '/fixture/profile', NODE_OPTIONS: '--invalid-inherited-option' };
    const fakeProcess = Object.assign(new EventEmitter(), {
      platform: 'linux', argv: ['node', 'start-client.cjs', ...args], env,
    });
    const module = { exports: {} };
    let launch;
    const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false });
    const mockRequire = name => name === 'node:fs' ? { existsSync: () => true }
      : name === 'node:child_process' ? { spawn: (binary, argv, options) => {
        launch = { binary, argv, options }; return child;
      } } : require(name);
    mockRequire.main = module;
    vm.runInNewContext(source, { require: mockRequire, module, process: fakeProcess,
      __dirname: path.join(__dirname, '../scripts'), console });
    assert.deepEqual(Array.from(launch.argv).slice(1), args);
    const expected = { ...env }; delete expected.NODE_OPTIONS;
    assert.deepEqual({ ...launch.options.env }, expected);
    assert.equal(launch.options.shell, false);
    assert.equal(fakeProcess.exitCode, 0);
    child.emit('exit', 0, null);
  }
});

test('portable launch forwards literal arguments, preserves the profile and returns the child exit code',
  { skip: process.platform === 'win32' ? 'Executable fixture uses a POSIX symlink; Windows layout is covered above.' : false }, t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-launcher with spaces-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const script = path.join(root, 'scripts/start-client.cjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '../scripts/start-client.cjs'), script);
    // Native bundle preparation is covered separately; this fixture isolates
    // argument forwarding and process ownership with a Node executable.
    fs.writeFileSync(path.join(root, 'scripts/source-macos-app.cjs'),
      'exports.prepareSourceApp = ({ binary }) => binary;');
    fs.mkdirSync(path.dirname(command(process.platform, root)), { recursive: true });
    fs.symlinkSync(process.execPath, command(process.platform, root));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ main: 'fixture.cjs' }));
    const receipt = path.join(root, 'receipt.json');
    fs.writeFileSync(path.join(root, 'fixture.cjs'), [
      "const fs = require('node:fs');",
      'fs.writeFileSync(' + JSON.stringify(receipt) + ', JSON.stringify({ cwd:process.cwd(), root:process.argv[1], args:process.argv.slice(2),',
      'nodeOptions:process.env.NODE_OPTIONS, asNode:process.env.ELECTRON_RUN_AS_NODE, crashpad:process.env.CHROME_CRASHPAD_PIPE_HANDLE,',
      'profile:process.env.SODUWORK_USER_DATA, proxy:process.env.HTTPS_PROXY }));',
      'process.exitCode = 37;',
    ].join('\n'));
    const args = ['--fixture-argument', 'two words', 'literal & spaces'];
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '--trace-warnings', ELECTRON_RUN_AS_NODE: '1',
        CHROME_CRASHPAD_PIPE_HANDLE: 'isolated-fixture-handle', SODUWORK_USER_DATA: 'isolated-fixture-profile',
        HTTPS_PROXY: 'http://proxy.invalid' } });
    assert.equal(result.error, undefined); assert.equal(result.status, 37, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), {
      cwd: root, root, args, profile: 'isolated-fixture-profile', proxy: 'http://proxy.invalid',
    });
  });

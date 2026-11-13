'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installerSpawnOptions } = require('../e2e/fixtures/installer-spawn-options.cjs');

test('NSIS directory tails remain unquoted while the executable is quoted', () => {
  const file = 'C:\\fixture path\\Setup.exe';
  for (const tail of ['/D=C:\\中文 install', '_?=C:\\中文 install']) {
    assert.deepEqual(installerSpawnOptions(file, ['/S', '/currentuser', tail]), {
      argv0: '"' + file + '"', windowsVerbatimArguments: true,
    });
    assert.throws(() => installerSpawnOptions(file, [tail, '/S']), /final argument/);
  }
});

test('ordinary application and helper arguments retain normal Node quoting', () => {
  assert.deepEqual(installerSpawnOptions('C:\\fixture path\\app.exe', ['--profile', 'C:\\profile path']), {});
  assert.deepEqual(installerSpawnOptions('powershell.exe', ['-Command', 'Write-Output "hello world"']), {});
});

test('real NSIS selects the requested Unicode directory instead of its default', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-nsis-args-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture installer.exe'), result = path.join(root, 'directory.txt');
  const script = path.join(root, 'fixture.nsi'), directory = path.join(root, '中文 install path');
  fs.writeFileSync(script, ['Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
    'OutFile "' + file + '"', 'InstallDir "$TEMP\\unused-default-directory"', 'Section',
    'FileOpen $0 "' + result + '" w', 'FileWriteUTF16LE $0 "$INSTDIR"', 'FileClose $0', 'SectionEnd'].join('\n'));
  const compiler = await require('app-builder-lib/out/toolsets/windows').getMakeNsisPath();
  const built = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script],
    { env: { ...process.env, ...compiler.env }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(built.status, 0, built.error?.message || built.stdout + built.stderr);
  const args = ['/S', '/D=' + directory];
  const installed = spawnSync(file, args, { ...installerSpawnOptions(file, args), timeout: 30000, windowsHide: true });
  assert.equal(installed.status, 0, installed.error?.message);
  assert.equal(fs.readFileSync(result, 'utf16le').replace(/^\uFEFF/, ''), directory);
});

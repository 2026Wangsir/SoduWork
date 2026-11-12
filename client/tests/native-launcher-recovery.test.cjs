'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');

test('production native launcher recovers previous payloads and interrupted flat-layout migrations',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-native-launcher-recovery-'));
    t.after(async () => {
      assert.equal(path.dirname(root), os.tmpdir());
      assert.match(path.basename(root), /^soduwork-native-launcher-recovery-/);
      await fs.rm(root, { recursive: true, force: true });
    });
    const compiler = await getMakeNsisPath();
    const run = (exe, args, timeout = 30000) => spawnSync(exe, args, {
      windowsHide: true, encoding: 'utf8', timeout, env: { ...process.env, ...compiler.env },
    });
    const entry = path.join(root, 'SoduWork.exe');
    const built = run(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8',
      '/DSODUWORK_LAUNCHER_OUT=' + entry,
      '/DSODUWORK_ICON=' + path.resolve(__dirname, '../icon.ico'),
      path.resolve(__dirname, '../build/launcher.nsi')]);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const marker = path.join(root, 'launched.txt'), payload = path.join(root, 'payload.exe');
    const script = path.join(root, 'payload.nsi');
    await fs.writeFile(script, [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
      `OutFile "${payload}"`, '!include "FileFunc.nsh"', 'Section',
      '${GetParameters} $1', `FileOpen $0 "${marker}" w`,
      'FileWrite $0 "$EXEDIR|$1"', 'FileClose $0', 'SectionEnd',
    ].join('\n'));
    const stub = run(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script]);
    assert.equal(stub.status, 0, stub.stdout + stub.stderr);
    const previous = path.join(root, '.soduwork-versions/previous');
    await fs.mkdir(previous, { recursive: true });
    await fs.copyFile(payload, path.join(previous, 'SoduWork.exe'));
    await fs.writeFile(path.join(previous, '.soduwork-release'), '1.0.0');
    await fs.writeFile(path.join(root, '.soduwork-previous'), 'previous');
    assert.equal(await fs.stat(path.join(root, '.soduwork-update.lock')).catch(() => null), null);

    async function launches(expected) {
      await fs.rm(marker, { force: true });
      const launched = run(entry, ['--recovery-check'], 5000);
      assert.equal(launched.status, 0, 'Launcher must finish recovery instead of looping: ' + launched.error);
      // Exec hands off to the payload; let its native process write the result.
      let value;
      for (let attempt = 0; attempt < 100; attempt++) {
        value = await fs.readFile(marker, 'utf8').catch(() => null);
        if (value) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(value, expected + '|--recovery-check');
    }
    await fs.writeFile(path.join(root, '.soduwork-active'), 'previous');
    await t.test('healthy active payload launches', () => launches(previous));
    await fs.rm(path.join(root, '.soduwork-active'));
    await t.test('missing active pointer falls back to previous', () => launches(previous));
    await fs.writeFile(path.join(root, '.soduwork-active'), 'incomplete');
    await t.test('incomplete active payload falls back to previous', () => launches(previous));
    await fs.rm(path.join(root, '.soduwork-previous'));
    await fs.copyFile(payload, path.join(root, 'SoduWork.previous.exe'));
    await t.test('interrupted first migration recovers the original executable', () => launches(root));
  });

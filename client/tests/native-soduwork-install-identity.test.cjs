'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');

test('native install upgrades only the owned SoduWork identity',
  { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-install-identity-'));
  const guid = randomUUID(), previousGuid = randomUUID();
  const installKey = 'Software\\' + guid, previousKey = 'Software\\' + previousGuid;
  const uninstallPrefix = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\';
  const uninstallKey = uninstallPrefix + guid, previousUninstallKey = uninstallPrefix + previousGuid;
  const keys = [installKey, uninstallKey, previousKey, previousUninstallKey];
  const registryView = process.arch === 'ia32' ? 32 : 64;
  const reg = args => spawnSync('reg.exe', [...args, '/reg:' + registryView],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  // Write typed values without routing embedded uninstaller quotes through a
  // native command line. Read each value back in the same explicit registry view.
  const seedScript = [
    "$ErrorActionPreference = 'Stop'",
    '$entries = ConvertFrom-Json $env:SODUWORK_IDENTITY_REGISTRY_FIXTURE',
    '$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, ' +
      `[Microsoft.Win32.RegistryView]::Registry${registryView})`,
    'try { foreach ($entry in $entries) {',
    '  $key = $base.CreateSubKey($entry.key)',
    '  try {',
    '    $key.SetValue($entry.name, [string]$entry.value, [Microsoft.Win32.RegistryValueKind]::String)',
    '    $actual = $key.GetValue($entry.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '    if ($actual -cne [string]$entry.value) { throw "Registry fixture round-trip failed: $($entry.name)" }',
    '  } finally { $key.Dispose() }',
    '} } finally { $base.Dispose() }',
  ].join('\n');
  const seed = entries => {
    assert.ok(entries.every(entry => keys.includes(entry.key)), 'Only fixture-owned keys may be seeded');
    const result = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(seedScript, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, SODUWORK_IDENTITY_REGISTRY_FIXTURE: JSON.stringify(entries) } });
    assert.equal(result.status, 0, 'Registry fixture setup: ' + result.stdout + result.stderr + (result.error || ''));
  };
  for (const key of keys) assert.notEqual(reg(['query', 'HKCU\\' + key]).status, 0);
  t.after(async () => {
    for (const key of keys) {
      reg(['delete', 'HKCU\\' + key, '/f']);
      assert.notEqual(reg(['query', 'HKCU\\' + key]).status, 0, 'Fixture registration was not removed: ' + key);
    }
    assert.equal(path.dirname(root).toLowerCase(), os.tmpdir().toLowerCase());
    assert.ok(path.basename(root).startsWith('soduwork-install-identity-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const quote = value => value.replaceAll('$', '$$');
  const script = path.join(root, 'identity.nsi'), exe = path.join(root, 'identity.exe');
  await fs.writeFile(script, [
    'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
    `OutFile "${quote(exe)}"`, '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
    '!define APP_ID "com.soduwork.update.e2e.identity"',
    '!define PRODUCT_NAME "SoduWork"',
    `!include "${quote(path.resolve(__dirname, '../build/installer-language.nsh'))}"`,
    '!define APP_EXECUTABLE_FILENAME "SoduWork.exe"', '!define UNINSTALL_FILENAME "Uninstall SoduWork.exe"',
    `!define SODUWORK_PREVIOUS_INSTALL_GUID "${previousGuid}"`,
    `!define INSTALL_REGISTRY_KEY "${installKey}"`, `!define UNINSTALL_REGISTRY_KEY "${uninstallKey}"`,
    `!include "${quote(path.resolve(__dirname, '../build/soduwork-install-identity.nsh'))}"`,
    ...['soduWorkRoot', 'installMode', 'fixtureMode', 'fixtureResult'].map(name => 'Var ' + name),
    'Section', 'SetShellVarContext current', `SetRegView ${registryView}`,
    'ReadEnvStr $INSTDIR SODUWORK_FIXTURE_ROOT', 'ReadEnvStr $fixtureMode SODUWORK_FIXTURE_MODE',
    'ReadEnvStr $fixtureResult SODUWORK_FIXTURE_RESULT', 'StrCpy $installMode "current"',
    '!insertmacro soduworkSelectIndependentDirectory', 'StrCpy $soduWorkRoot $INSTDIR',
    '!insertmacro soduworkDetectPreviousInstall',
    'FileOpen $R9 "$fixtureResult.diagnostics" w',
    `ReadRegStr $R8 HKCU "${previousKey}" InstallLocation`,
    String.raw`FileWrite $R9 "rawInstallLocation=$R8$\r$\n"`,
    String.raw`FileWrite $R9 "registryView=${registryView}$\r$\nmode=$fixtureMode$\r$\n"`,
    String.raw`FileWrite $R9 "normalizedInstallLocation=$0$\r$\nuninstallString=$1$\r$\n"`,
    String.raw`FileWrite $R9 "displayName=$2$\r$\ndisplayVersion=$3$\r$\nexpectedScope=$4$\r$\nnormalizedTarget=$5$\r$\n"`,
    '${If} ${FileExists} "$soduWorkRoot\\${APP_EXECUTABLE_FILENAME}"',
    String.raw`FileWrite $R9 "launcherExists=1$\r$\n"`, '${Else}', String.raw`FileWrite $R9 "launcherExists=0$\r$\n"`, '${EndIf}',
    '${If} ${FileExists} "$soduWorkRoot\\.soduwork-active"',
    String.raw`FileWrite $R9 "activeMarkerExists=1$\r$\n"`, '${Else}', String.raw`FileWrite $R9 "activeMarkerExists=0$\r$\n"`, '${EndIf}',
    'FileClose $R9',
    '${If} $fixtureMode != "missing-new-registration"',
    `WriteRegStr HKCU "${installKey}" InstallLocation "$soduWorkRoot"`,
    `WriteRegStr HKCU "${uninstallKey}" UninstallString '\"$soduWorkRoot\\Uninstall SoduWork.exe\" /currentuser'`, '${EndIf}',
    '${If} $fixtureMode == "retargeted-registration"',
    `WriteRegStr HKCU "${previousKey}" InstallLocation "$soduWorkRoot\\another-install"`, '${EndIf}',
    '!insertmacro soduworkCommitPreviousInstall',
    'FileOpen $0 "$fixtureResult" w', 'FileWrite $0 "$soduWorkRoot|$soduworkPreviousInstallMatched"',
    'FileClose $0', 'SetErrorLevel 0', 'SectionEnd', '',
  ].join('\n'));
  const compiler = await getMakeNsisPath();
  const built = spawnSync(compiler.path, ['/V2', '/INPUTCHARSET', 'UTF8', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, ...compiler.env } });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  for (const mode of ['owned', 'foreign-root', 'foreign-scope', 'foreign-uninstaller',
    'missing-new-registration', 'missing-new-uninstaller', 'retargeted-registration', 'missing-launcher']) {
    const brand = 'SoduWork';
    const directory = path.join(root, mode, brand), target = path.join(root, mode, 'SoduWork');
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    for (const key of keys) reg(['delete', 'HKCU\\' + key, '/f']);
    await fs.writeFile(path.join(directory, brand + '.exe'), 'existing-launcher');
    if (mode === 'missing-launcher') await fs.rm(path.join(directory, brand + '.exe'));
    await fs.writeFile(path.join(directory, '.soduwork-active'), 'previous-version');
    await fs.writeFile(path.join(directory, 'profile-fixture.txt'), 'existing-data');
    if (mode !== 'missing-new-uninstaller') await fs.writeFile(path.join(target, 'Uninstall SoduWork.exe'), 'current-uninstaller');
    seed([
      { key: previousKey, name: 'InstallLocation', value: mode === 'foreign-root' ? root : directory },
      { key: previousUninstallKey, name: 'DisplayName', value: brand + ' 1.12.86' },
      { key: previousUninstallKey, name: 'DisplayVersion', value: '1.12.86' },
      { key: previousUninstallKey, name: 'UninstallString', value: '"' + path.join(directory,
        mode === 'foreign-uninstaller' ? 'foreign.exe' : 'Uninstall ' + brand + '.exe') + '" ' +
        (mode === 'foreign-scope' ? '/allusers' : '/currentuser') },
    ]);
    const resultFile = path.join(root, mode, 'result');
    const result = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...process.env, SODUWORK_FIXTURE_ROOT: directory, SODUWORK_FIXTURE_MODE: mode, SODUWORK_FIXTURE_RESULT: resultFile } });
    assert.equal(result.status, 0, mode + ': ' + result.stdout + result.stderr);
    const matched = !['foreign-root', 'foreign-scope', 'foreign-uninstaller', 'missing-launcher'].includes(mode);
    const diagnostics = await fs.readFile(resultFile + '.diagnostics', 'utf8')
      .catch(error => 'NSIS diagnostics unavailable: ' + error.code);
    assert.equal((await fs.readFile(resultFile, 'utf8')).toLowerCase(), `${target}|${matched ? 1 : 0}`.toLowerCase(),
      mode + '\n' + diagnostics);
    for (const key of [previousKey, previousUninstallKey]) {
      assert.equal(reg(['query', 'HKCU\\' + key]).status === 0, mode !== 'owned', mode + ': previous registration');
    }
    if (mode === 'missing-launcher') {
      assert.equal(await fs.stat(path.join(directory, brand + '.exe')).then(() => true, () => false), false);
    } else assert.equal(await fs.readFile(path.join(directory, brand + '.exe'), 'utf8'), 'existing-launcher');
    assert.equal(await fs.readFile(path.join(directory, 'profile-fixture.txt'), 'utf8'), 'existing-data');
    if (mode !== 'missing-new-uninstaller') {
      assert.equal(await fs.readFile(path.join(target, 'Uninstall SoduWork.exe'), 'utf8'), 'current-uninstaller');
    }
  }
});

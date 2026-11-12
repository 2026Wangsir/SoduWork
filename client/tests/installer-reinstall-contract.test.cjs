'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
test('updates stage immutable payloads without invoking an old uninstaller or deleting live files', () => {
  const s = read('build/install-versioned.nsh');
  assert.doesNotMatch(s, /!insertmacro (uninstallOldVersion|handleUninstallResult|_soduworkStopAll)/);
  assert.doesNotMatch(s, /Delete "\$appExe"|RMDir \/r "\$INSTDIR"/);
  assert.match(s, /!insertmacro soduworkReplaceLauncher/);
  assert.doesNotMatch(s, /kernel32::ReplaceFileW/);
  assert.match(read('build/installer.nsh'), /MoveFileExW.*i 9/);
  assert.match(s, /SoduWork\.previous\.exe/);
  assert.match(s, /MoveFileExW.*soduwork-active.*i 9/);
  assert.ok(s.indexOf('.soduwork-verify.cjs') < s.indexOf('w "$soduWorkRoot\\.soduwork-active", i 9'));
});
test('legacy /S updates preserve existing links; manual installs still use the standard wizard', () => {
  assert.match(read('build/install-versioned.nsh'), /\$\{Silent\}[\s\S]*keepShortcuts "true"/);
  assert.match(read('scripts/prepare-installer.cjs'), /NSIS transaction hooks changed/);
  assert.doesNotMatch(read('build/installer.nsh'), /taskkill|RMDir|DeleteReg/);
});

test('enabled desktop/start-menu shortcuts use the exact upstream global', () => {
  const source = read('build/install-versioned.nsh');
  assert.match(source, /Var \/GLOBAL keepShortcuts/);
  assert.match(source, /!insertmacro addStartMenuLink \$keepShortcuts/);
  assert.match(source, /!insertmacro addDesktopLink \$keepShortcuts/);
});
test('stable launcher waits for the installer and can recover the original layout', () => {
  const s = read('build/launcher.nsi');
  assert.match(s, /CreateFileW/);
  assert.match(s, /SetErrorLevel 0\s+Quit/);
  assert.match(s, /\$1 == 32/);
  assert.match(s, /SoduWork\.previous\.exe/);
  // The distribution's executable name is also used for isolated fixtures.
  assert.match(s, /soduwork-versions\\\$target\\\$exeName/);
  assert.match(s, /StrCpy \$exeName "\$\{SODUWORK_EXECUTABLE_NAME\}"/);
});

test('ordinary and UAC inner installs execute the same transaction with upstream uninstaller', () => {
  const hook = read('build/installer.nsh');
  const section = read('build/installSection.nsh');
  assert.match(hook, /!macro customHeader[\s\S]*!cd/);
  assert.match(section, /!include.*install-versioned\.nsh/);
  assert.doesNotMatch(section, /UAC_IsInnerInstance|uninstallOldVersion/);
  assert.equal(JSON.parse(read('package.json')).build.nsis.script, undefined);
});

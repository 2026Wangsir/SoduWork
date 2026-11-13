'use strict';
// Execute the production NSIS macros only under a unique test registry key.
// No Explorer association, default app, installed client or uninstall key is changed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
if(process.platform!=='win32')throw Error('Windows registration test requires Windows');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-file-registration-'));
const out=path.resolve(__dirname,'../../outputs/file-open-20261014');fs.mkdirSync(out,{recursive:true});
const key='Software\\SoduWorkFileOpenTest-'+randomUUID();
const compiler=path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const source=path.join(root,'registration.nsi'),exe=path.join(root,'registration.exe'),receipt=path.join(root,'passed.txt');
const script=String.raw`
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "SoduWork isolated file registration test"
OutFile "${exe}"
!include "LogicLib.nsh"
!define SHELL_CONTEXT HKCU
!define PRODUCT_NAME "SoduWork"
!include "${path.resolve(__dirname,'../build/installer-language.nsh')}"
!define APP_EXECUTABLE_FILENAME "SoduWork.exe"
!define SODUWORK_FILE_VERB "${key}\Verb"
!define SODUWORK_OPEN_APP "${key}\Application"
!include "${path.resolve(__dirname,'../build/file-open.nsh')}"
Var appExe
Section
  StrCpy $INSTDIR "${root}\中文 & folder"
  StrCpy $appExe "$INSTDIR\SoduWork.exe"
  !insertmacro soduworkRegisterFileOpen
  ReadRegStr $0 HKCU "${key}\Verb\command" ""
  ${'${If}'} $0 != '"$appExe" --soduwork-open-file "%1"'
    Goto failed
  ${'${EndIf}'}
  ReadRegStr $0 HKCU "${key}\Application\shell\open\command" ""
  ${'${If}'} $0 != '"$appExe" --soduwork-open-file "%1"'
    Goto failed
  ${'${EndIf}'}
  StrCpy $INSTDIR "${root}\another-install"
  !insertmacro customUnInstall
  ReadRegStr $0 HKCU "${key}\Verb\command" ""
  ${'${If}'} $0 == ""
    Goto failed
  ${'${EndIf}'}
  StrCpy $INSTDIR "${root}\中文 & folder"
  !insertmacro customUnInstall
  ReadRegStr $0 HKCU "${key}\Verb\command" ""
  ${'${If}'} $0 != ""
    Goto failed
  ${'${EndIf}'}
  ReadRegStr $0 HKCU "${key}\Application\shell\open\command" ""
  ${'${If}'} $0 != ""
    Goto failed
  ${'${EndIf}'}
  FileOpen $0 "${receipt}" w
  FileWrite $0 "passed"
  FileClose $0
  DeleteRegKey HKCU "${key}"
  SetErrorLevel 0
  Quit
  failed:
  DeleteRegKey HKCU "${key}"
  SetErrorLevel 2
SectionEnd
`;
fs.writeFileSync(source,'\ufeff'+script);
const built=spawnSync(compiler,['/V2',source],{encoding:'utf8',windowsHide:true});
assert.equal(built.status,0,built.stdout+'\n'+built.stderr);
const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
assert.equal(run.status,0,run.stderr);assert.equal(fs.readFileSync(receipt,'utf8'),'passed');
const report={ok:true,cases:['Production registration macros compile and quote Unicode/space/metacharacter launcher paths correctly','Register context action and Open With application under installation scope','Uninstall preserves entries owned by another install and removes its own entries'],boundary:'HKCU unique test key only; Explorer menu and installed SoduWork were not modified.'};
fs.writeFileSync(path.join(out,'registration.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));

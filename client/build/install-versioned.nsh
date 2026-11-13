; Only the destructive install section changes; wizard/registry/uninstaller stay upstream.
; Payloads are immutable. Launcher and shortcut targets never disappear.
; installer.nsh is already loaded by the standard install section.
InitPluginsDir
Var /GLOBAL soduworkStage
Var /GLOBAL soduworkStageName
Var /GLOBAL soduworkLock
Var /GLOBAL soduworkOldPointer
Var /GLOBAL soduworkLauncherBackup
; Upstream addStartMenuLink/addDesktopLink access this exact global name.
Var /GLOBAL keepShortcuts
!insertmacro soduworkSelectIndependentDirectory
StrCpy $soduWorkRoot "$INSTDIR"
System::Call 'kernel32::GetTickCount64() l .r0'
StrCpy $soduWorkStartedAt $0
StrCpy $soduworkLock 0
StrCpy $keepShortcuts "false"
StrCpy $appExe "$soduWorkRoot\${APP_EXECUTABLE_FILENAME}"
!insertmacro setLinkVars
CreateDirectory "$soduWorkRoot"
; Housekeeping maintenance holds this lock exclusively for seconds while it
; retires and deletes old payloads (size-dependent). Retry briefly so an
; installer started inside that window succeeds instead of reporting a false
; "another update is running"; a genuinely concurrent installer still fails
; closed after the window.
System::Call 'kernel32::CreateFileW(w "$soduWorkRoot\.soduwork-update.lock", i 0xC0000000, i 0, p 0, i 4, i 0, p 0) p .r0'
StrCpy $1 0
${Do}
  ${If} $0 != -1
    ${Break}
  ${EndIf}
  IntOp $1 $1 + 1
  ${If} $1 > 60
    ${Break}
  ${EndIf}
  ${If} $1 == 1
    !insertmacro soduworkLog "lock-wait"
  ${EndIf}
  Sleep 500
  System::Call 'kernel32::CreateFileW(w "$soduWorkRoot\.soduwork-update.lock", i 0xC0000000, i 0, p 0, i 4, i 0, p 0) p .r0'
${Loop}
${If} $0 == -1
  MessageBox MB_OK|MB_ICONINFORMATION "$(soduworkUpdateBusy)" /SD IDOK
  SetErrorLevel 1618
  Quit
${EndIf}
StrCpy $soduworkLock $0
!insertmacro soduworkDetectPreviousInstall
${If} ${FileExists} "$appExe"
  ; Legacy clients passed /S only: still preserve their shortcuts.
  ${If} ${Silent}
  ${OrIf} ${isUpdated}
    StrCpy $keepShortcuts "true"
  ${EndIf}
${EndIf}
!insertmacro soduworkLog "staging"
!insertmacro soduworkPhase "preparing"
!insertmacro soduWorkProgress 0 0 0
; Persist the UI language the running client supplied via the environment so
; the observer and any shortcut opened mid-transaction render the same strings.
; A missing marker (legacy installers) keeps the default Chinese strings.
ReadEnvStr $0 "SODUWORK_UPDATE_LANG"
${If} $0 != ""
  FileOpen $1 "$soduWorkRoot\.soduwork-update-locale" w
  ${IfNot} ${Errors}
    FileWrite $1 "$0"
    FileClose $1
  ${EndIf}
${EndIf}
; Refresh the launcher before extraction, including already-versioned installs.
; Older launchers can bypass the install lock. Keep the same shortcut path and
; atomically replace its bytes; never unlink the live entry point.
SetOutPath "$PLUGINSDIR"
File /oname=soduwork-launcher.exe "${PROJECT_DIR}\.runtime\installer\SoduWorkLauncher.exe"
ClearErrors
CopyFiles /SILENT "$PLUGINSDIR\soduwork-launcher.exe" "$soduWorkRoot\.soduwork-launcher.next"
${If} ${Errors}
  !insertmacro soduworkLog "launcher-prepare-failed"
  SetErrorLevel 2
  Quit
${EndIf}
; Preserve the original pre-versioned application for interrupted migrations.
; A subsequent launcher refresh must not replace that legacy recovery binary.
StrCpy $soduworkLauncherBackup "$soduWorkRoot\SoduWork.previous.exe"
${If} ${FileExists} "$soduWorkRoot\.soduwork-launcher"
  StrCpy $soduworkLauncherBackup "$soduWorkRoot\.soduwork-launcher.previous.exe"
${EndIf}
${If} ${FileExists} "$appExe"
  !insertmacro soduworkReplaceLauncher "$appExe" "$soduWorkRoot\.soduwork-launcher.next" "$soduworkLauncherBackup"
${Else}
  StrCpy $2 "entry-create"
  System::Call 'kernel32::MoveFileExW(w "$soduWorkRoot\.soduwork-launcher.next", w "$appExe", i 8) i .r0 ?e'
  Pop $1
${EndIf}
${If} $0 == 0
  ; Backup/ACL/rename failure leaves the live entry in place; no payload pointer
  ; has been changed, so there is no destructive restore operation to race.
  !insertmacro soduworkLog "launcher-swap-failed operation=$2 win32=$1"
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(soduworkLauncherUpdateFailed)" /SD IDOK
  SetErrorLevel 2
  Quit
${EndIf}
FileOpen $0 "$soduWorkRoot\.soduwork-launcher" w
FileWrite $0 "1"
FileClose $0
${If} ${Silent}
  ; Show a lightweight native progress window even when an old helper passed /S.
  ; Closing that window does not cancel the transaction.
  ; Run a separate observer so installer progress does not depend on a user
  ; opening the stable shortcut. Closing it never cancels the transaction.
  SetOutPath "$PLUGINSDIR"
  File /oname=soduwork-update-progress.exe "${PROJECT_DIR}\.runtime\installer\SoduWorkLauncher.exe"
  System::Call 'kernel32::SetEnvironmentVariableW(w "SODUWORK_UPDATE_ROOT", w "$soduWorkRoot")'
  Exec '"$PLUGINSDIR\soduwork-update-progress.exe" --soduwork-update-wait'
  System::Call 'kernel32::SetEnvironmentVariableW(w "SODUWORK_UPDATE_ROOT", p 0)'
${EndIf}
; Expensive IO happens in a fresh directory on the target volume.
; The stable entry is refreshed before any payload stage becomes visible.
CreateDirectory "$soduWorkRoot\.soduwork-versions"
SetOutPath "$soduWorkRoot"
GetTempFileName $soduworkStage "$soduWorkRoot\.soduwork-versions"
Delete "$soduworkStage"
CreateDirectory "$soduworkStage"
FileOpen $0 "$soduworkStage\.soduwork-stage" w
FileWrite $0 "1"
FileClose $0
${GetFileName} "$soduworkStage" $soduworkStageName
SetOutPath "$soduworkStage"
StrCpy $INSTDIR "$soduworkStage"
ClearErrors
!insertmacro soduworkPhase "extracting"
!insertmacro soduWorkExtractPayload "$soduworkStage"
${If} ${Errors}
  StrCpy $INSTDIR "$soduWorkRoot"
  !insertmacro soduworkLog "native-extraction-failed"
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(soduworkExtractionFailed)" /SD IDOK
  Quit
${EndIf}
File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
StrCpy $INSTDIR "$soduWorkRoot"
${IfNot} ${FileExists} "$soduworkStage\${APP_EXECUTABLE_FILENAME}"
${OrIfNot} ${FileExists} "$soduworkStage\resources\app.asar"
  !insertmacro soduworkLog "payload-incomplete"
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(soduworkPayloadIncomplete)" /SD IDOK
  Quit
${EndIf}
; Installation checks the Python bootstrap ZIP for existence only, as authorized.
; Other files and the default release/package verification remain unchanged.
; A failed runtime launch must not leave a previous attempt's diagnostics looking current.
Delete "$soduWorkRoot\.soduwork-update-details.json"
!insertmacro soduworkLog "verifying $soduworkStageName"
!insertmacro soduworkPhase "verifying"
!insertmacro soduworkLog "verification-policy=bootstrap-existence-only"
; Incomplete DLL/runtime/Runner extraction cannot be mistaken for a successful install.
System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
nsExec::ExecToStack '"$soduworkStage\${APP_EXECUTABLE_FILENAME}" "$soduworkStage\.soduwork-verify.cjs" "$soduworkStage" "$soduWorkRoot\.soduwork-update-details.json" --installation --progress-file "$soduWorkRoot\.soduwork-update-progress"'
Pop $0
Pop $1
System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p 0)'
${If} $0 != 0
  !insertmacro soduworkLog "payload-verification-failed"
  DetailPrint "$1"
  FileOpen $9 "$soduWorkRoot\.soduwork-update.log" a
  FileSeek $9 0 END
  FileWrite $9 "verifier-exit=$0$\r$\n$1$\r$\n"
  FileClose $9
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONEXCLAMATION "$(soduworkVerificationFailed)$\r$\n$soduWorkRoot\.soduwork-update.log$\r$\n$soduWorkRoot\.soduwork-update-details.json" /SD IDOK
  Quit
${EndIf}
FileOpen $0 "$soduworkStage\.soduwork-release" w
FileWrite $0 "${VERSION}"
FileClose $0
!insertmacro soduworkLog "prepared"
!insertmacro soduworkPhase "activating"
!insertmacro soduWorkProgress 99 0 0
SetOutPath "$soduWorkRoot"
!ifdef UNINSTALLER_ICON
  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
!endif
CopyFiles /SILENT "$soduworkStage\${UNINSTALL_FILENAME}" "$soduWorkRoot\${UNINSTALL_FILENAME}"
${If} ${Errors}
  !insertmacro soduworkLog "uninstaller-copy-failed"
  SetErrorLevel 2
  Quit
${EndIf}
; Never delete the active pointer before the atomic switch.
StrCpy $soduworkOldPointer ""
${If} ${FileExists} "$soduWorkRoot\.soduwork-active"
  FileOpen $0 "$soduWorkRoot\.soduwork-active" r
  FileRead $0 $soduworkOldPointer
  FileClose $0
  CopyFiles /SILENT "$soduWorkRoot\.soduwork-active" "$soduWorkRoot\.soduwork-previous"
${EndIf}
ClearErrors
FileOpen $0 "$soduWorkRoot\.soduwork-active.next" w
FileWrite $0 "$soduworkStageName"
FileClose $0
${If} ${Errors}
  !insertmacro soduworkLog "pointer-write-failed"
  SetErrorLevel 2
  Quit
${EndIf}
System::Call 'kernel32::MoveFileExW(w "$soduWorkRoot\.soduwork-active.next", w "$soduWorkRoot\.soduwork-active", i 9) i .r0'
${If} $0 == 0
  !insertmacro soduworkLog "pointer-switch-failed"
  SetErrorLevel 2
  Quit
${EndIf}
; Preserve the installation scope explicitly when both user and machine installs exist.
FileOpen $0 "$soduWorkRoot\.soduwork-install-mode" w
FileWrite $0 "$installMode"
FileClose $0
!insertmacro registryAddInstallInfo
!insertmacro addStartMenuLink $keepShortcuts
!insertmacro addDesktopLink $keepShortcuts
!insertmacro soduworkCommitPreviousInstall
StrCpy $launchLink "$appExe"
!insertmacro soduworkRegisterFileOpen
!ifmacrodef registerFileAssociations
  !insertmacro registerFileAssociations
!endif
; Commit is shared by ordinary and elevated installs.
!insertmacro soduworkLog "committed"
; Retired payload maintenance runs after the new client has started. Recursive
; deletion must never keep an already committed update locked or delay relaunch.
!insertmacro soduworkPhase "committed"
!insertmacro soduWorkProgress 100 0 0
; The locale marker is only meaningful while a transaction is in flight.
Delete "$soduWorkRoot\.soduwork-update-locale"
System::Call 'kernel32::CloseHandle(p $soduworkLock)'
StrCpy $soduworkLock 0
; Fire-and-forget maintenance inherits this installer's existing elevation.
; It waits until after launch, retires under the same native lock, then releases
; that lock before deletion. Current-user installs also retry at client startup.
System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
Exec '"$soduworkStage\${APP_EXECUTABLE_FILENAME}" "$soduworkStage\.soduwork-prune.cjs" --schedule'
System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p 0)'
SetErrorLevel 0
; Helper owns silent relaunch; manual setup retains the standard finish page.

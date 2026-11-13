; Preserve upstream wizard/UAC and signed uninstaller. Override only its install
; section through NSIS's documented compiler include search, including UAC inner instances.
!ifdef BUILD_RESOURCES_DIR
  !ifdef BUILD_UNINSTALLER
    !include "${BUILD_RESOURCES_DIR}\uninstall-resources.nsh"
    !include "${BUILD_RESOURCES_DIR}\uninstall-user-data.nsh"
  !endif
  !include "${BUILD_RESOURCES_DIR}\soduwork-install-identity.nsh"
  !include "${BUILD_RESOURCES_DIR}\file-open.nsh"
!endif
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    ; Package-check expands the payload macro in preInit, before the install
    ; Section. Declare its optional progress destination before either caller.
    Var soduWorkRoot
    Var soduWorkStartedAt
    !include "${PROJECT_DIR}\.runtime\installer\native-payload.nsh"
    !include "${BUILD_RESOURCES_DIR}\package-check.nsh"
  !else
    !insertmacro soduworkUninstallDataFunctions
  !endif
  !addincludedir "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis"
  !include "${BUILD_RESOURCES_DIR}\installer-language.nsh"
  ; Use the Windows UI font that contains each selected script. The default
  ; shell font can render Korean/Japanese NSIS strings as vertical tofu on a
  ; Simplified Chinese desktop even though the language resource is correct.
  SetFont "Segoe UI" 9
  SetFont /LANG=2052 "Microsoft YaHei UI" 9
  SetFont /LANG=1041 "Meiryo UI" 9
  SetFont /LANG=1042 "Malgun Gothic" 9
  !cd "${BUILD_RESOURCES_DIR}"
  ; Upstream process-check functions are intentionally unused: no global process killing.
  ; Keep all other compiler warnings fatal.
  !pragma warning disable 6010 ; unused upstream _GetProcessInfo
  !pragma warning disable 6001 ; unused upstream pid/old-uninstall variables
!macroend

; Rename over the destination in one filesystem operation. A live reader can
; cause transient access/sharing errors; retry without removing either file.
; Returns success in $0 and the last Windows error in $1.
!macro soduworkMoveLauncher source destination
  Push $R0
  StrCpy $R0 0
  ${Do}
    System::Call 'kernel32::MoveFileExW(w "${source}", w "${destination}", i 9) i .r0 ?e'
    Pop $1
    ${If} $0 != 0
      StrCpy $1 0
      ${Break}
    ${EndIf}
    ${If} $1 != 5
    ${AndIf} $1 != 32
      ${Break}
    ${EndIf}
    IntOp $R0 $R0 + 1
    ${If} $R0 >= 40
      ${Break}
    ${EndIf}
    Sleep 25
  ${Loop}
  Pop $R0
!macroend

; MoveFileEx does not merge the destination's ACL like ReplaceFile does. Copy
; the existing entry's DACL, including its inheritance protection, before moving
; the prepared launcher. Refuse the swap if its permissions cannot be preserved.
!macro soduworkCopyLauncherDacl source destination
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  StrCpy $0 0
  StrCpy $R1 0
  System::Call 'advapi32::GetNamedSecurityInfoW(w "${source}", i 1, i 4, p 0, p 0, *p .R0, p 0, *p .R1) i .r1'
  ${If} $1 == 0
    System::Call 'advapi32::GetSecurityDescriptorControl(p R1, *i .R2, *i .R3) i .r0 ?e'
    Pop $1
    ${If} $0 != 0
      IntOp $R2 $R2 & 0x1000
      ${If} $R2 != 0
        StrCpy $R2 0x80000004
      ${Else}
        StrCpy $R2 0x20000004
      ${EndIf}
      System::Call 'advapi32::SetNamedSecurityInfoW(w "${destination}", i 1, i R2, p 0, p 0, p R0, p 0) i .r1'
      StrCpy $0 0
      ${If} $1 == 0
        StrCpy $0 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $R1 != 0
    System::Call 'kernel32::LocalFree(p R1)'
  ${EndIf}
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; Preserve a recovery entry separately, then replace the live pathname. Unlike
; ReplaceFileW, this never temporarily renames the live file to its backup.
; Returns success/error in $0/$1 and the failure operation in $2.
!macro soduworkReplaceLauncher live prepared backup
  ${Do}
    StrCpy $2 "entry-permissions"
    !insertmacro soduworkCopyLauncherDacl "${live}" "${prepared}"
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    StrCpy $2 "backup-link"
    Delete "${backup}.next"
    System::Call 'kernel32::CreateHardLinkW(w "${backup}.next", w "${live}", p 0) i .r0 ?e'
    Pop $1
    ${If} $0 == 0
      ; Volumes without hard-link support still preserve the original bytes.
      StrCpy $2 "backup-copy"
      System::Call 'kernel32::CopyFileW(w "${live}", w "${backup}.next", i 1) i .r0 ?e'
      Pop $1
      ${If} $0 != 0
        StrCpy $2 "backup-permissions"
        !insertmacro soduworkCopyLauncherDacl "${live}" "${backup}.next"
      ${EndIf}
    ${EndIf}
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    StrCpy $2 "backup-activate"
    !insertmacro soduworkMoveLauncher "${backup}.next" "${backup}"
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    StrCpy $2 "entry-activate"
    !insertmacro soduworkMoveLauncher "${prepared}" "${live}"
    ${Break}
  ${Loop}
!macroend

!ifdef BUILD_UNINSTALLER
  !macro customCheckAppRunning
    ; Do not force-kill ongoing AI work during uninstall.
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $0
    ${If} $0 == 0
      MessageBox MB_OK|MB_ICONINFORMATION "$(soduworkQuitBeforeUninstall)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  !macroend
!endif

!macro soduworkLog phase
  Push $0
  System::Call 'kernel32::GetTickCount64() l .r0'
  System::Int64Op $0 - $soduWorkStartedAt
  Pop $0
  FileOpen $9 "$soduWorkRoot\.soduwork-update.log" a
  FileSeek $9 0 END
  FileWrite $9 "${VERSION} ${phase} elapsedMs=$0$\r$\n"
  FileClose $9
  Pop $0
!macroend

; Fixed phase identifiers only; this file is presentation, never authority for
; installation success or pointer switching. A partial read is ignored by the UI.
!macro soduworkPhase phase
  FileOpen $9 "$soduWorkRoot\.soduwork-update-phase" w
  FileWrite $9 "${phase}"
  FileClose $9
  ClearErrors
!macroend

; Best-effort presentation channel, never an installation decision. Preserve the
; caller's registers and error flag: a progress write must not mask failed IO.
!macro soduWorkProgress percent completed total
  Push $0
  Push $1
  Push $2
  StrCpy $2 0
  ${If} ${Errors}
    StrCpy $2 1
  ${EndIf}
  ${If} $soduWorkRoot != ""
    ClearErrors
    FileOpen $0 "$soduWorkRoot\.soduwork-update-progress.next" w
    ${IfNot} ${Errors}
      FileWrite $0 "${percent}|${completed}|${total}"
      FileClose $0
      ${IfNot} ${Errors}
        System::Call 'kernel32::MoveFileExW(w "$soduWorkRoot\.soduwork-update-progress.next", w "$soduWorkRoot\.soduwork-update-progress", i 1) i .r1'
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${If} $2 == 1
    SetErrors
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

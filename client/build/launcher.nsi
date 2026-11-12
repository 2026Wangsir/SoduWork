; Stable entry point and a single, compact observer of the install transaction.
Unicode true
RequestExecutionLevel user
ManifestDPIAware true
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
BrandingText " "
SetFont "Segoe UI" 9
!ifndef SODUWORK_EXECUTABLE_NAME
  !define SODUWORK_EXECUTABLE_NAME "SoduWork.exe"
!endif
Name "SoduWork"
Caption "SoduWork 正在更新"
OutFile "${SODUWORK_LAUNCHER_OUT}"
Icon "${SODUWORK_ICON}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "StrFunc.nsh"
!include "nsDialogs.nsh"
${StrStr}
${StrTok}
${StrCase}
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
SetFont /LANG=2052 "Segoe UI" 9
Page custom CreateUpdatePage
Var target
Var arguments
Var count
Var pointer
Var exeName
Var updateRoot
Var updatePhase
Var updateBusy
Var updateMutex
!include "launcher-progress.nsh"
Function CheckUpdateLock
  StrCpy $updateBusy 0
  ; Read the error in the same call; another plugin call can overwrite it.
  System::Call 'kernel32::CreateFileW(w "$updateRoot\.soduwork-update.lock", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p .r0 ?e'
  Pop $1
  ${If} $0 == -1
    ${If} $1 == 32
      StrCpy $updateBusy 1
    ${EndIf}
  ${Else}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
FunctionEnd
Function .onInit
  ${GetParameters} $arguments
  StrCpy $updateRoot "$EXEDIR"
  ${If} $arguments == "--soduwork-update-wait"
    ReadEnvStr $0 "SODUWORK_UPDATE_ROOT"
    ${If} $0 != ""
      StrCpy $updateRoot "$0"
    ${EndIf}
  ${EndIf}
  Call CheckUpdateLock
  ${If} $updateBusy == 1
    ; Installation-scoped UI ownership. An observer and shortcut can both wait,
    ; but only one shows a window. OS releases this mutex even after a crash.
    GetFullPathName $2 "$updateRoot"
    ${StrCase} $2 $2 "L"
    StrLen $3 $2
    IntOp $3 $3 * 2
    System::Call 'shlwapi::HashData(w r2, i r3, *i .r4, i 4)'
    ; Only need to keep/read its lifetime, not modify a mutex owned by an
    ; elevated updater. ALL_ACCESS can fail across UAC and create a second UI.
    System::Call 'kernel32::CreateMutexExW(p 0, w "Local\SoduWork.Update.$4", i 0, i 0x100000) p .r0 ?e'
    Pop $1
    StrCpy $updateMutex $0
    ${If} $1 == 183
      ; Do not keep the owner's mutex object alive from an invisible waiter.
      ; If the user closes the window, another launch can show it again.
      System::Call 'kernel32::CloseHandle(p $updateMutex)'
      StrCpy $updateMutex 0
      ${If} $arguments == "--soduwork-update-wait"
        SetErrorLevel 0
        Quit
      ${EndIf}
      ; A shortcut request still launches the final active version when ready.
    ${Else}
      SetSilent normal
    ${EndIf}
  ${EndIf}
  ; updateRoot is final here; both the observer window and the failure
  ; message box below pick their strings from this single decision.
  Call ReadUpdateLocale
FunctionEnd
Section
  StrCpy $count 0
  waitForInstall:
    Call CheckUpdateLock
    ${If} $updateBusy == 1
      Sleep 250
      IntOp $count $count + 1
      ${If} $count < 2400
        Goto waitForInstall
      ${EndIf}
      SetErrorLevel 1460
      Quit
    ${EndIf}
  Call LaunchPayload
SectionEnd
Function LaunchPayload
  ${If} $arguments == "--soduwork-update-wait"
    SetErrorLevel 0
    Quit
  ${EndIf}
  StrCpy $pointer ".soduwork-active"
  readPointer:
  StrCpy $target ""
  ClearErrors
  FileOpen $0 "$EXEDIR\$pointer" r
  ${IfNot} ${Errors}
    FileRead $0 $target
    FileClose $0
  ${EndIf}
  ; Only one generated directory name, never a command or absolute path.
  ${StrStr} $1 $target "\"
  ${StrStr} $2 $target "/"
  ${StrStr} $3 $target ".."
  ${StrStr} $4 $target ":"
  ; Try each pointer once, then recover the previous payload or original layout.
  StrCpy $exeName "${SODUWORK_EXECUTABLE_NAME}"
  ${If} $target != ""
  ${AndIf} $1 == ""
  ${AndIf} $2 == ""
  ${AndIf} $3 == ""
  ${AndIf} $4 == ""
  ${AndIf} ${FileExists} "$EXEDIR\.soduwork-versions\$target\.soduwork-release"
  ${AndIf} ${FileExists} "$EXEDIR\.soduwork-versions\$target\$exeName"
    SetOutPath "$EXEDIR\.soduwork-versions\$target"
    ClearErrors
    Exec '"$EXEDIR\.soduwork-versions\$target\$exeName" $arguments'
    ${IfNot} ${Errors}
      SetErrorLevel 0
      Quit
    ${EndIf}
  ${EndIf}
  !if "${SODUWORK_EXECUTABLE_NAME}" == "SoduWork.exe"
  ${If} $pointer == ".soduwork-active"
    StrCpy $pointer ".soduwork-previous"
    Goto readPointer
  ${EndIf}
  ; Interrupted first migration: original binary/resources have not been deleted.
  ${If} ${FileExists} "$EXEDIR\SoduWork.previous.exe"
    SetOutPath "$EXEDIR"
    ClearErrors
    Exec '"$EXEDIR\SoduWork.previous.exe" $arguments'
    ${IfNot} ${Errors}
      SetErrorLevel 0
      Quit
    ${EndIf}
  ${EndIf}
  !endif
  ${If} $updateEnglish != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "The SoduWork installation is incomplete. Run the installer again to repair it; your sessions and files will not be deleted."
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "SoduWork 安装尚未完成。请重新运行安装包修复；你的会话与文件不会被删除。"
  ${EndIf}
  SetErrorLevel 2
FunctionEnd

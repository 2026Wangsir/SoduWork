; Remove long runtime paths using the installed Electron's Node mode. The
; native uninstaller remains responsible for its files, shortcuts and registry.
!macro soduworkPrepareResourceUninstall
  InitPluginsDir
  File /oname=$PLUGINSDIR\soduwork-uninstall-resources.cjs "${BUILD_RESOURCES_DIR}\uninstall-resources.cjs"
  ClearErrors
  FileOpen $0 "$INSTDIR\.soduwork-active" r
  ${If} ${Errors}
    StrCpy $1 ""
    ClearErrors
  ${Else}
    FileRead $0 $1
    FileClose $0
  ${EndIf}
  StrCpy $3 ""
  ; A single generated directory component, never a command or parent path.
  ${If} $1 != ""
    System::Call 'shlwapi::PathIsFileSpecW(w r1) i .r2'
    ${If} $2 == 0
    ${OrIf} $1 == "."
    ${OrIf} $1 == ".."
      SetErrorLevel 2
      Abort "Invalid active installation pointer."
    ${EndIf}
    ${If} ${FileExists} "$INSTDIR\.soduwork-versions\$1\.soduwork-release"
      ${If} ${FileExists} "$INSTDIR\.soduwork-versions\$1\${APP_EXECUTABLE_FILENAME}"
        StrCpy $3 "$INSTDIR\.soduwork-versions\$1\${APP_EXECUTABLE_FILENAME}"
      ${ElseIf} ${FileExists} "$INSTDIR\.soduwork-versions\$1\SoduWork.exe"
        StrCpy $3 "$INSTDIR\.soduwork-versions\$1\SoduWork.exe"
      ${ElseIf} ${FileExists} "$INSTDIR\.soduwork-versions\$1\SoduWork.exe"
        StrCpy $3 "$INSTDIR\.soduwork-versions\$1\SoduWork.exe"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; A first flat-layout migration can copy this uninstaller before its active
  ; pointer commit fails. Its preserved original Electron remains usable.
  ${If} $3 == ""
  ${AndIf} ${FileExists} "$INSTDIR\SoduWork.previous.exe"
    StrCpy $3 "$INSTDIR\SoduWork.previous.exe"
  ${EndIf}
  ${If} $3 == ""
  ${OrIfNot} ${FileExists} "$INSTDIR\.soduwork-launcher"
    SetErrorLevel 2
    Abort "Installation ownership markers are missing."
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "NODE_OPTIONS", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "NODE_PATH", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
  ; Use Windows' native alias only for I/O; the helper validates its real root
  ; and every ancestor before accepting it. Systems without 8.3 names retain
  ; their original spelling, without requiring a machine policy change.
  GetFullPathName /SHORT $4 "$INSTDIR"
  ${If} $4 == ""
    StrCpy $4 "$INSTDIR"
  ${EndIf}
  StrCpy $5 ""
  ${If} $soduworkDeleteUserData == 1
  ${AndIfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    StrCpy $5 "$soduworkCurrentAppData"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=120000 '"$3" "$PLUGINSDIR\soduwork-uninstall-resources.cjs" "$INSTDIR" "$4" "$5" "${PRODUCT_NAME}"'
  Pop $0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p 0)'
  ${If} $0 != 0
    DetailPrint "$1"
    !insertmacro soduworkDataText $1 \
      "Installed resources or selected local data could not be safely removed. External workspaces and Hub service data are unchanged." \
      "无法安全删除安装资源或所选本地数据。外部工作区和 Hub 服务数据未更改。" \
      "インストール済みリソースまたは選択したローカルデータを安全に削除できませんでした。外部ワークスペースと Hub サービスのデータは変更されていません。" \
      "설치된 리소스 또는 선택한 로컬 데이터를 안전하게 삭제할 수 없습니다. 외부 작업 공간과 Hub 서비스 데이터는 변경되지 않았습니다."
    SetErrorLevel 2
    Abort "$1"
  ${EndIf}
!macroend

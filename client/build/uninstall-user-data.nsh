; User data is retained unless the interactive uninstaller receives both an
; unchecked-by-default selection and a second confirmation. Updates never opt in.
!include "nsDialogs.nsh"
Var soduworkDeleteUserData
Var soduworkUserDataCheck
Var soduworkCurrentAppData
Var soduworkUserDataTarget

; Other upstream installer languages use English until a translation exists.
!macro soduworkDataText target english chinese japanese korean
  ${If} $LANGUAGE == 2052
    StrCpy ${target} "${chinese}"
  ${ElseIf} $LANGUAGE == 1041
    StrCpy ${target} "${japanese}"
  ${ElseIf} $LANGUAGE == 1042
    StrCpy ${target} "${korean}"
  ${Else}
    StrCpy ${target} "${english}"
  ${EndIf}
!macroend

!ifdef DELETE_APP_DATA_ON_UNINSTALL
  !error "User data removal requires the interactive SoduWork confirmation."
!endif

!macro customUnInit
  StrCpy $soduworkDeleteUserData 0
  SetShellVarContext current
  StrCpy $soduworkCurrentAppData "$APPDATA"
  StrCpy $soduworkUserDataTarget "$APPDATA\${PRODUCT_NAME}"
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
  ; electron-builder otherwise treats this legacy flag as unconditional
  ; recursive deletion. Do not allow it to bypass the choice or safety checks.
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--delete-app-data" $1
  ${IfNot} ${Errors}
    !insertmacro soduworkDataText $0 \
      "To remove local data, run the uninstaller interactively and confirm the data cleanup option." \
      "如需清理本地数据，请打开卸载向导，勾选并确认数据清理选项。" \
      "ローカルデータを削除するには、アンインストール画面でデータ削除を選択し、確認してください。" \
      "로컬 데이터를 삭제하려면 제거 마법사에서 데이터 삭제 옵션을 선택하고 확인하세요."
    MessageBox MB_OK|MB_ICONSTOP "$0" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.soduworkUserDataPage un.soduworkUserDataLeave
!macroend

; Compile the functions only after electron-builder adds its plugin paths.
!macro soduworkUninstallDataFunctions
Function un.soduworkUserDataPage
  ${If} ${Silent}
  ${OrIf} ${isUpdated}
    Abort
  ${EndIf}
  StrCpy $soduworkDeleteUserData 0
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro soduworkDataText $1 "Local application data" "本地应用数据" "ローカルアプリデータ" "로컬 앱 데이터"
  !insertmacro soduworkDataText $2 \
    "Keep your data to use it again after reinstalling." "默认保留数据，便于重新安装后继续使用。" \
    "再インストール後に利用できるよう、既定ではデータを保持します。" "다시 설치한 후 사용할 수 있도록 기본적으로 데이터를 보관합니다."
  !insertmacro MUI_HEADER_TEXT "$1" "$2"
  !insertmacro soduworkDataText $0 \
    "Optional: delete this Windows account's local settings, sign-in information, conversations and caches. This cannot be undone.$\r$\n$\r$\nOnly this folder will be removed:" \
    "可选：删除当前 Windows 账户的本地设置、登录信息、会话和缓存。此操作无法撤销。$\r$\n$\r$\n仅清理以下目录：" \
    "任意：この Windows アカウントのローカル設定、ログイン情報、会話、キャッシュを削除します。元に戻せません。$\r$\n$\r$\n削除するのは次のフォルダーのみです：" \
    "선택 사항: 현재 Windows 계정의 로컬 설정, 로그인 정보, 대화 및 캐시를 삭제합니다. 되돌릴 수 없습니다.$\r$\n$\r$\n다음 폴더만 삭제합니다:"
  ${NSD_CreateLabel} 0 0 100% 32% "$0"
  Pop $0
  !insertmacro soduworkDataText $0 \
    "External workspaces, other Windows accounts, Hub service data and custom data folders are kept." \
    "不会删除外部工作区、其他 Windows 账户、Hub 服务或自定义数据目录。" \
    "外部ワークスペース、他の Windows アカウント、Hub サービスのデータ、カスタムデータフォルダーは保持されます。" \
    "외부 작업 공간, 다른 Windows 계정, Hub 서비스 데이터 및 사용자 지정 데이터 폴더는 유지됩니다."
  ${NSD_CreateLabel} 0 62% 100% 21% "$0"
  Pop $0
  !insertmacro soduworkDataText $0 \
    "Also delete the local application data shown above" "卸载时同时删除上述本地应用数据" \
    "上記のローカルアプリデータも削除する" "위의 로컬 앱 데이터도 삭제"
  ${NSD_CreateCheckbox} 0 87% 100% 12% "$0"
  Pop $soduworkUserDataCheck
  ${NSD_Uncheck} $soduworkUserDataCheck
  ${NSD_CreateText} 0 36% 100% 18% "$soduworkUserDataTarget"
  Pop $0
  SendMessage $0 ${EM_SETREADONLY} 1 0
  nsDialogs::Show
FunctionEnd

Function un.soduworkUserDataLeave
  ${NSD_GetState} $soduworkUserDataCheck $0
  StrCpy $soduworkDeleteUserData 0
  ${If} $0 == ${BST_CHECKED}
    !insertmacro soduworkDataText $0 \
      "Permanently delete this folder and all local application data inside it?$\r$\n$\r$\n$soduworkUserDataTarget$\r$\n$\r$\nThis cannot be undone. External workspaces and Hub service data will be kept." \
      "永久删除以下目录及其中全部本地应用数据？$\r$\n$\r$\n$soduworkUserDataTarget$\r$\n$\r$\n此操作无法撤销。外部工作区和 Hub 服务数据将保留。" \
      "このフォルダーと中のすべてのローカルアプリデータを完全に削除しますか？$\r$\n$\r$\n$soduworkUserDataTarget$\r$\n$\r$\n元に戻せません。外部ワークスペースと Hub サービスのデータは保持されます。" \
      "이 폴더와 폴더 안의 모든 로컬 앱 데이터를 영구 삭제할까요?$\r$\n$\r$\n$soduworkUserDataTarget$\r$\n$\r$\n되돌릴 수 없습니다. 외부 작업 공간과 Hub 서비스 데이터는 유지됩니다."
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$0" IDYES soduwork_data_confirmed
    ${NSD_Uncheck} $soduworkUserDataCheck
    Abort
    soduwork_data_confirmed:
    StrCpy $soduworkDeleteUserData 1
  ${EndIf}
FunctionEnd
!macroend

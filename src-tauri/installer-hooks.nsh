; "Open in Tarex UI" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTarex" "" "Open in Tarex UI"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTarex" "Icon" '"$INSTDIR\tarex-ui.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTarex" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInTarex\command" "" '"$INSTDIR\tarex-ui.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTarex" "" "Open in Tarex UI"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTarex" "Icon" '"$INSTDIR\tarex-ui.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTarex" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInTarex\command" "" '"$INSTDIR\tarex-ui.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTarex" "" "Open in Tarex UI"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTarex" "Icon" '"$INSTDIR\tarex-ui.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTarex" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInTarex\command" "" '"$INSTDIR\tarex-ui.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTarex"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTarex"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTarex"
!macroend

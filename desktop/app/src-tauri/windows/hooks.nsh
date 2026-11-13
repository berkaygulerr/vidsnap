; Vidsnap NSIS hooks (per-user install, currentUser mode)

; Kill Vidsnap processes of the current user: app, native-messaging host,
; and yt-dlp/ffmpeg/ffprobe whose image path is inside $INSTDIR\bin.
!macro VidsnapKillAll
  DetailPrint "Çalışan Vidsnap kapatılıyor…"
  nsExec::Exec 'taskkill /F /T /IM vidsnap-app.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM vidsnap-host.exe'
  Pop $0
  nsExec::Exec 'powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Process yt-dlp,ffmpeg,ffprobe -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path.StartsWith(\"$INSTDIR\bin\", [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  SetShellVarContext current
  ; Is the browser-spawned host running? (CSV output starts with a quote when found)
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq vidsnap-host.exe" /FO CSV /NH'
  Pop $0
  Pop $1
  StrCpy $1 $1 1
  ${If} $1 == '"'
    IfSilent vs_pre_kill
    ${If} $PassiveMode <> 1
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Vidsnap şu an çalışıyor (tarayıcıda indirme olabilir). Devam edilirse kapatılacak." IDOK vs_pre_kill
      Abort
    ${EndIf}
  ${EndIf}
  vs_pre_kill:
  !insertmacro VidsnapKillAll
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  SetShellVarContext current
  !insertmacro VidsnapKillAll
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.vidsnap.host"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.vidsnap.host"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.vidsnap.host"
!macroend

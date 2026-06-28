!macro customInstall
  ; 설치 전 실행 중인 MC DevKit 강제 종료
  nsExec::Exec 'taskkill /f /im "MC DevKit.exe"'
  Sleep 1500
!macroend

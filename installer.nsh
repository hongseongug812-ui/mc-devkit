!macro customInit
  ; 인스톨러 시작 즉시 실행 중인 MC DevKit 강제 종료
  nsExec::Exec 'taskkill /f /im "MC DevKit.exe"'
  Pop $R0
  Sleep 2000
!macroend

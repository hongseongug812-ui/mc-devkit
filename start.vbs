Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

Dim dir
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = ""

Dim electron
electron = dir & "\node_modules\.bin\electron.cmd"

If fso.FileExists(electron) Then
    sh.Run Chr(34) & electron & Chr(34) & " .", 0, False
Else
    sh.Run "cmd /c npx electron .", 0, False
End If

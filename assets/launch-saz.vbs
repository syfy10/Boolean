' Launches Boolean's app window with no console window.
' The server exits by itself when the app window is closed.
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & dir & "\saz.exe"" ui --auto-exit", 0, False

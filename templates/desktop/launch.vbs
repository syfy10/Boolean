' Opens app.html as a chromeless Edge app window (a real desktop window).
Dim sh, fso, dir
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "msedge --app=""file:///" & Replace(dir, "\", "/") & "/app.html""", 1, False

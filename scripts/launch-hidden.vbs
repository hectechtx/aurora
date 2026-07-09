' Runs launch.cmd with a fully hidden window (no console flash at logon).
' Window style 0 = hidden; False = don't wait for it to exit.
Dim fso, scriptDir, shell
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run """" & scriptDir & "\launch.cmd""", 0, False

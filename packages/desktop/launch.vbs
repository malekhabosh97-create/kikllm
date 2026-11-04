Set WshShell = CreateObject("WScript.Shell")
Set FileSystem = CreateObject("Scripting.FileSystemObject")
DesktopFolder = FileSystem.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = FileSystem.GetParentFolderName(FileSystem.GetParentFolderName(DesktopFolder))
WshShell.Run "cmd.exe /c pnpm.cmd --filter @paperclipai/desktop start", 0, False

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\malek\Documents\freellm work"
WshShell.Run "cmd.exe /c pnpm.cmd --filter @paperclipai/desktop start", 0, False

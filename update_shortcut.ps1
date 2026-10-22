$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("C:\Users\malek\Desktop\FreeLLM Browser.lnk")
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = '/c "C:\Users\malek\Desktop\FreeLLM_Browser.bat"'
$Shortcut.WorkingDirectory = "C:\Users\malek\Desktop"
$Shortcut.WindowStyle = 7 # 7 = Minimized (Runs without flashing black cmd window!)
$Shortcut.Description = "Open FreeLLM Browser for DeepSeek"
$Shortcut.IconLocation = "C:\Program Files\Google\Chrome\Application\chrome.exe,0"
$Shortcut.Save()
Write-Output "Updated FreeLLM Browser.lnk to run minimized launcher with Chrome icon."

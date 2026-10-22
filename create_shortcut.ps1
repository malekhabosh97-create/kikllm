$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("C:\Users\malek\Desktop\FreeLLM Browser.lnk")
$Shortcut.TargetPath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$Shortcut.Arguments = '--remote-debugging-port=9222 --user-data-dir="C:\Users\malek\.freellm-browser-profile" --no-first-run --no-default-browser-check https://chat.deepseek.com'
$Shortcut.WorkingDirectory = "C:\Program Files\Google\Chrome\Application"
$Shortcut.Description = "Open FreeLLM Browser for DeepSeek"
$Shortcut.IconLocation = "C:\Program Files\Google\Chrome\Application\chrome.exe,0"
$Shortcut.Save()
Write-Output "Shortcut created successfully at C:\Users\malek\Desktop\FreeLLM Browser.lnk"

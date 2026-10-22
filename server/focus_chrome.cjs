const { execSync } = require('child_process');

const ps = `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;

  public class WinFocus {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  }
"@

$wscript = New-Object -ComObject WScript.Shell
$wscript.AppActivate("DeepSeek")
$wscript.AppActivate("Google Chrome")

Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.MainWindowHandle -ne 0) {
    [WinFocus]::ShowWindowAsync($_.MainWindowHandle, 9) # 9 = SW_RESTORE
    [WinFocus]::SetForegroundWindow($_.MainWindowHandle)
    [WinFocus]::SwitchToThisWindow($_.MainWindowHandle, $true)
  }
}
Write-Output "Focus command executed"
`;

try {
  require('fs').writeFileSync('focus_chrome.ps1', ps);
  const out = execSync('powershell -ExecutionPolicy Bypass -File focus_chrome.ps1', { encoding: 'utf8' });
  console.log(out);
} catch (e) {
  console.error("Error:", e.message);
}

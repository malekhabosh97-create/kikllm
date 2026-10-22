const { execSync } = require('child_process');

try {
  const result = execSync('powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id, SessionId, MainWindowTitle, MainWindowHandle | ConvertTo-Json -Compress"', { encoding: 'utf8' });
  console.log("Visible Chrome windows with titles:");
  console.log(result);
} catch (e) {
  console.error("Error:", e.message);
}

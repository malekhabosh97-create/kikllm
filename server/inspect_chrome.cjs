const { execSync } = require('child_process');

try {
  const result = execSync('powershell -NoProfile -Command "Get-Process chrome -ErrorAction SilentlyContinue | Select-Object Id, SessionId, MainWindowTitle, MainWindowHandle | ConvertTo-Json -Compress"', { encoding: 'utf8' });
  console.log("Chrome processes:");
  console.log(result);
} catch (e) {
  console.error("Error:", e.message);
}

try {
  const cimResult = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Select-Object ProcessId, SessionId, CommandLine | ConvertTo-Json -Compress"', { encoding: 'utf8' });
  const data = JSON.parse(cimResult || '[]');
  const procs = Array.isArray(data) ? data : (data ? [data] : []);
  console.log("\nChrome with freellm-browser-profile:");
  for (const p of procs) {
    if (p.CommandLine && p.CommandLine.includes('freellm-browser-profile')) {
      console.log(`PID: ${p.ProcessId}, SessionId: ${p.SessionId}, Cmd: ${p.CommandLine}`);
    }
  }
} catch (e) {
  console.error("Error in CIM:", e.message);
}

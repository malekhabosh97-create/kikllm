const { execSync } = require('child_process');

try {
  const cimResult = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Select-Object ProcessId, ParentProcessId, SessionId, CommandLine | ConvertTo-Json -Compress"', { encoding: 'utf8' });
  const data = JSON.parse(cimResult || '[]');
  const procs = Array.isArray(data) ? data : (data ? [data] : []);
  console.log(`Total chrome processes: ${procs.length}`);
  for (const p of procs) {
    if (p.CommandLine && p.CommandLine.includes('freellm-browser-profile')) {
      const isType = p.CommandLine.includes('--type=');
      console.log(`PID: ${p.ProcessId}, ParentPID: ${p.ParentProcessId}, IsType: ${isType}, Cmd: ${p.CommandLine.slice(0, 100)}`);
    }
  }
} catch (e) {
  console.error("Error:", e.message);
}

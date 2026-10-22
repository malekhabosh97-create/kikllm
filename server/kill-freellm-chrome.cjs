const { execSync } = require('child_process');

try {
  const result = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"', { encoding: 'utf8' });
  const data = JSON.parse(result);
  const procs = Array.isArray(data) ? data : (data ? [data] : []);
  
  let killed = 0;
  for (const proc of procs) {
    if (proc.CommandLine && proc.CommandLine.includes('freellm-browser-profile')) {
      console.log(`Killing Chrome PID ${proc.ProcessId}: ${proc.CommandLine.substring(0, 80)}...`);
      try {
        execSync(`taskkill /F /PID ${proc.ProcessId}`);
        killed++;
      } catch (err) {
        console.error(`Failed to kill PID ${proc.ProcessId}:`, err.message);
      }
    }
  }
  console.log(`Finished. Killed ${killed} processes.`);
} catch (e) {
  console.error('Error:', e.message);
}

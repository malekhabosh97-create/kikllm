const { spawn } = require('child_process');

console.log("Starting Chrome directly to observe stdout/stderr...");
const child = spawn(
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    "--remote-debugging-port=9222",
    '--user-data-dir=C:\\Users\\malek\\.freellm-browser-profile',
    "--no-first-run",
    "--no-default-browser-check",
    "https://chat.deepseek.com"
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

child.stdout.on('data', d => console.log('STDOUT:', d.toString()));
child.stderr.on('data', d => console.error('STDERR:', d.toString()));

child.on('close', code => console.log('Exited with code:', code));

setTimeout(() => {
  console.log('5 seconds elapsed, killing test child...');
  child.kill();
}, 5000);

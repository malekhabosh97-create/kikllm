const http = require('http');
const fs = require('fs');

const token = fs.readFileSync('C:\\Users\\malek\\.freellm-browser-profile\\token.txt', 'utf8').trim();

const reqData = JSON.stringify({
  prompt: 'Answer with only the word: SUCCESS',
  platform: 'gemini',
  model: 'gemini-default'
});

console.log('Sending test prompt to /chat with platform=gemini...');
const req = http.request(
  {
    hostname: '127.0.0.1',
    port: 3150,
    path: '/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(reqData),
      'x-freellm-auth': token,
    },
  },
  (res) => {
    console.log('Status Code:', res.statusCode);
    res.on('data', chunk => {
      process.stdout.write(chunk.toString());
    });
    res.on('end', () => {
      console.log('\n--- Stream finished ---');
    });
  }
);

req.on('error', err => console.error('Request error:', err));
req.write(reqData);
req.end();

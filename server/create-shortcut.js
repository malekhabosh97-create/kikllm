import { execSync } from "node:child_process";

const desktopLnk = "C:\\Users\\malek\\Desktop\\FreeLLM Browser.lnk";
const arabicLnk = "C:\\Users\\malek\\Desktop\\متصفح FreeLLM.lnk";
const chromeExe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profileDir = "C:\\Users\\malek\\.freellm-browser-profile";
const args = `--remote-debugging-port=9222 --user-data-dir=\\"${profileDir}\\" --no-first-run --no-default-browser-check https://chat.deepseek.com`;

const ps = `
$w = New-Object -ComObject WScript.Shell

$s1 = $w.CreateShortcut('${desktopLnk}')
$s1.TargetPath = '${chromeExe}'
$s1.Arguments = '${args}'
$s1.IconLocation = '${chromeExe},0'
$s1.Description = 'FreeLLM Browser'
$s1.Save()

$s2 = $w.CreateShortcut('${arabicLnk}')
$s2.TargetPath = '${chromeExe}'
$s2.Arguments = '${args}'
$s2.IconLocation = '${chromeExe},0'
$s2.Description = 'FreeLLM Browser'
$s2.Save()

Write-Output 'Shortcuts created successfully'
`;

try {
  const out = execSync(`powershell -Command "${ps.trim().replace(/\r?\n/g, '; ')}"`).toString();
  console.log(out);
} catch (e) {
  console.error("Failed to create shortcut:", e.message);
}

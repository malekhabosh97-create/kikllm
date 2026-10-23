@echo off
echo ======================================================
echo Launching Chrome for Google Gemini Manual Login
echo Profile: C:\Users\malek\.freellm-gemini-profile
echo ======================================================
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\malek\.freellm-gemini-profile" --no-first-run "https://gemini.google.com/app"
echo.
echo Chrome has been launched.
echo 1. Sign in to your Google Account in the Chrome window.
echo 2. Complete any 2FA prompts.
echo 3. Make sure you reach the Gemini chat screen.
echo 4. Close Chrome when done, then return to Antigravity chat.
echo.
pause

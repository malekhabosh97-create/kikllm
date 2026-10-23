@echo off
echo ======================================================
echo Launching Chrome for DeepSeek Manual Login
echo Profile: C:\Users\malek\.freellm-deepseek-profile
echo ======================================================
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\Users\malek\.freellm-deepseek-profile" --no-first-run "https://chat.deepseek.com"
echo.
echo Chrome has been launched.
echo 1. Sign in to your DeepSeek Account in the Chrome window.
echo 2. Make sure you reach the DeepSeek chat screen.
echo 3. Close Chrome when done.
echo.
pause

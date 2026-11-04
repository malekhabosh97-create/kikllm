@echo off
echo ======================================================
echo Starting Paperclip FreeLLM Work Server & UI...
echo ======================================================
set PAPERCLIP_RUNNER_BINARY=C:\Windows\System32\cmd.exe
set PAPERCLIP_MIGRATION_AUTO_APPLY=true
set PAPERCLIP_MIGRATION_PROMPT=never
set PORT=3100
cd /d "C:\Users\malek\Documents\freellm work"
node cli/node_modules/tsx/dist/cli.mjs scripts/dev-runner.ts dev
pause

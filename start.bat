@echo off
title FreeLLM Work Launcher
cd /d "%~dp0"
echo Starting FreeLLM Work...
.\.venv\Scripts\python.exe run.py
pause

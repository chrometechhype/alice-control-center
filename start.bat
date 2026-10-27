@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 20 or newer: https://nodejs.org/
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\acc-start.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. Check data\logs\server-error.log
  pause
  exit /b 1
)
exit /b 0

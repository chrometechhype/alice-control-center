@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 20 or newer: https://nodejs.org/
  pause
  exit /b 1
)

if /i "%~1"=="--full-debug" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\acc-full-debug.ps1"
  set "ACC_DEBUG_CODE=%errorlevel%"
  echo.
  pause
  exit /b %ACC_DEBUG_CODE%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\acc-start.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. Check data\logs\server-error.log
  pause
  exit /b 1
)
exit /b 0

@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 20 or newer: https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :error
)

if not exist dist (
  echo Building frontend...
  call npm run build
  if errorlevel 1 goto :error
)

echo Starting Alice Control Center on http://127.0.0.1:8722
call npm start
exit /b %errorlevel%

:error
echo.
echo Startup failed. Check the error above.
pause
exit /b 1

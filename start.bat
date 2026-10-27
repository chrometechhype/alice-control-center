@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js 20 or newer: https://nodejs.org/
  pause
  exit /b 1
)

rem Already running? Just open the panel.
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 8722); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:8722"
  exit /b 0
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
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:8722'"
call npm start
exit /b %errorlevel%

:error
echo.
echo Startup failed. Check the error above.
pause
exit /b 1

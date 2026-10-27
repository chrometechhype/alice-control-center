param(
  [switch]$NoBrowser,
  [switch]$NoTray,
  [switch]$Silent
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'acc-common.ps1')

function Write-AccStartError([string]$message) {
  if ($Silent) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.MessageBox]::Show($message, 'Alice Control Center', 'OK', 'Error') | Out-Null
    } catch {
      Write-Host $message
    }
  } else {
    Write-Host $message -ForegroundColor Red
  }
}

function Invoke-AccNpm([string[]]$arguments) {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npm) { throw 'npm не найден. Установите Node.js 20 или новее: https://nodejs.org/' }
  Push-Location (Get-AccRoot)
  try {
    & $npm.Source @arguments
    if ($LASTEXITCODE -ne 0) { throw "npm $($arguments[0]) завершился с кодом $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

try {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-AccStartError 'Node.js не найден. Установите Node.js 20 или новее: https://nodejs.org/'
    exit 1
  }
  $nodeVersion = & $node.Source -v 2>$null
  if ($nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -lt 20) {
    Write-AccStartError "Нужен Node.js 20 или новее, установлен $nodeVersion."
    exit 1
  }

  $root = Get-AccRoot
  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    if (-not $Silent) { Write-Host 'Устанавливаю зависимости…' }
    Invoke-AccNpm @('install', '--no-audit', '--no-fund')
  }
  if (-not (Test-Path (Join-Path $root 'dist\index.html'))) {
    if (-not $Silent) { Write-Host 'Собираю интерфейс…' }
    Invoke-AccNpm @('run', 'build')
  }

  if (-not (Start-AccBackend)) {
    Write-AccStartError "Не удалось запустить панель. Журнал: $(Join-Path $root 'data\logs\server-error.log')"
    exit 1
  }

  if (-not $NoTray) {
    $tray = Join-Path $PSScriptRoot 'acc-tray.ps1'
    if (Test-Path $tray) {
      $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      Start-Process -FilePath $powershell `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tray`"" `
        -WindowStyle Hidden
    }
  }

  if (-not $NoBrowser) { Open-AccPanel }
  exit 0
} catch {
  Write-AccStartError "Ошибка запуска: $($_.Exception.Message)"
  exit 1
}

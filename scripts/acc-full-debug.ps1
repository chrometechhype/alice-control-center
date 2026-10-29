param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'acc-common.ps1')

function Write-AccDebugError([string]$message) {
  Write-Host $message -ForegroundColor Red
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
    Write-AccDebugError 'Node.js не найден. Установите Node.js 20 или новее: https://nodejs.org/'
    exit 1
  }
  $nodeVersion = & $node.Source -v 2>$null
  if ($nodeVersion -match '^v(\d+)\.' -and [int]$Matches[1] -lt 20) {
    Write-AccDebugError "Нужен Node.js 20 или новее, установлен $nodeVersion."
    exit 1
  }

  $root = Get-AccRoot
  if (-not (Test-Path (Join-Path $root 'node_modules\tsx\dist\cli.mjs'))) {
    Write-Host 'Устанавливаю зависимости…'
    Invoke-AccNpm @('install', '--no-audit', '--no-fund')
  }

  $tsx = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
  Push-Location $root
  try {
    & $node.Source $tsx 'server/cli/fullDebug.ts' '--full-debug'
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }

  if ($code -ne 0) {
    Write-AccDebugError "Полная отладка завершилась с кодом $code."
    exit $code
  }
  Write-Host "Отчёт сохранён в $(Join-Path $root 'data\reports')." -ForegroundColor Green
  exit 0
} catch {
  Write-AccDebugError "Ошибка полной отладки: $($_.Exception.Message)"
  exit 1
}

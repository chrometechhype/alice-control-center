$script:AccPort = 8722
$script:AccRoot = Split-Path -Parent $PSScriptRoot

function Get-AccRoot {
  return $script:AccRoot
}

function Get-AccBaseUrl {
  return "http://127.0.0.1:$script:AccPort"
}

function Get-AccHealth {
  try {
    return Invoke-RestMethod -Uri "$(Get-AccBaseUrl)/api/health" -TimeoutSec 2 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-AccRunning {
  $health = Get-AccHealth
  return [bool]($health -and $health.ok)
}

function Get-AccListeningProcess {
  $connection = Get-NetTCPConnection -LocalPort $script:AccPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $connection) {
    return $null
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    ProcessId   = [int]$connection.OwningProcess
    Name        = $process.Name
    CommandLine = $process.CommandLine
  }
}

function Start-AccBackend {
  if (Test-AccRunning) {
    return $true
  }
  $root = Get-AccRoot
  $tsx = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node -or -not (Test-Path $tsx)) {
    return $false
  }
  $logDir = Join-Path $root 'data\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $env:ACC_PORT = [string]$script:AccPort
  Start-Process -FilePath $node.Source `
    -ArgumentList @($tsx, 'server/index.ts') `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'server.log') `
    -RedirectStandardError (Join-Path $logDir 'server-error.log') | Out-Null
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (Test-AccRunning) {
      return $true
    }
  }
  return $false
}

function Stop-AccBackend {
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    $process = Get-AccListeningProcess
    if (-not $process) {
      return $true
    }
    if ($process.Name -and $process.Name -ne 'node.exe') {
      return $false
    }
    if ($process.CommandLine -and $process.CommandLine -notmatch 'server[\\/]index\.ts') {
      return $false
    }
    # tsx spawns a child that keeps the port, so re-scan after every kill.
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 300
  }
  return -not (Get-AccListeningProcess)
}

function Restart-AccBackend {
  Stop-AccBackend | Out-Null
  Start-Sleep -Milliseconds 600
  return Start-AccBackend
}

function Open-AccPanel {
  Start-Process (Get-AccBaseUrl)
}

function Get-AccVersion {
  $health = Get-AccHealth
  if ($health -and $health.data -and $health.data.version) {
    return [string]$health.data.version
  }
  $package = Join-Path (Get-AccRoot) 'package.json'
  if (Test-Path $package) {
    try {
      return [string](Get-Content $package -Raw | ConvertFrom-Json).version
    } catch {
      return $null
    }
  }
  return $null
}

function Check-AccUpdates {
  try {
    return Invoke-RestMethod -Method Post -Uri "$(Get-AccBaseUrl)/api/updates/check" `
      -ContentType 'application/json' -Body '{"force":true}' -TimeoutSec 45 -ErrorAction Stop
  } catch {
    return $null
  }
}

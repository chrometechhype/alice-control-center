# Alice Control Center installer for Windows.
#
# One-line install:
#   irm https://raw.githubusercontent.com/chrometechhype/alice-control-center/main/install.ps1 | iex
#
# Installs into %LOCALAPPDATA%\AliceControlCenter (override with ACC_INSTALL_DIR),
# keeps the existing data folder, verifies SHA-256 and creates a desktop shortcut.
# Set ACC_VERSION to a tag (for example v1.0.0-alpha.1) to install a prerelease.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Install-AliceControlCenter {
  $repo = 'chrometechhype/alice-control-center'
  $port = 8722
  # A prerelease is invisible to /releases/latest, so a tag asks for it by name.
  $tag = if ($env:ACC_VERSION) { $env:ACC_VERSION } else { $null }
  $installDir = if ($env:ACC_INSTALL_DIR) { $env:ACC_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'AliceControlCenter' }

  function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
  }

  function Assert-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { return $false }
    $version = & $node.Source -v 2>$null
    if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -lt 20) {
      throw "Node.js $version is too old. Install Node.js 20 or newer: https://nodejs.org/"
    }
    return $true
  }

  function Stop-RunningPanel {
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if (-not $listener) { break }
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
      if (-not $process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'server[\\/]index\.ts') {
        throw "Port $port is used by another program. Close it and run the installer again."
      }
      Write-Host 'Stopping the running panel...'
      # tsx spawns a child that keeps the port, so re-scan after every kill.
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
    }
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
      throw "Port $port is still busy. Stop the panel and run the installer again."
    }
    $trays = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'acc-tray\.ps1' }
    foreach ($tray in $trays) {
      try { Stop-Process -Id $tray.ProcessId -Force -ErrorAction Stop } catch { }
    }
  }

  Write-Host ''
  Write-Host 'Alice Control Center installer'
  Write-Host '------------------------------'

  if (-not (Assert-Node)) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
      throw 'Node.js 20+ is required. Install it from https://nodejs.org/ and run the installer again.'
    }
    $answer = Read-Host 'Node.js 20+ is required. Install Node.js LTS with winget now? [y/N]'
    if ($answer -notmatch '^[Yy]') {
      throw 'Node.js 20+ is required. Install it from https://nodejs.org/ and run the installer again.'
    }
    & $winget.Source install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    Update-SessionPath
    if (-not (Assert-Node)) {
      throw 'Node.js was installed but is not available yet. Open a new terminal and run the installer again.'
    }
  }

  $headers = @{ 'User-Agent' = 'acc-installer'; 'Accept' = 'application/vnd.github+json' }
  $releaseUrl = if ($tag) {
    Write-Host "Fetching release $tag..."
    "https://api.github.com/repos/$repo/releases/tags/$tag"
  } else {
    Write-Host 'Fetching the latest release...'
    "https://api.github.com/repos/$repo/releases/latest"
  }
  $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers -TimeoutSec 30
  $version = $release.tag_name -replace '^v', ''
  $zipAsset = $release.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1
  $sumAsset = $release.assets | Where-Object { $_.name -like '*.zip.sha256' } | Select-Object -First 1
  if (-not $zipAsset) { throw 'The latest release has no ZIP archive.' }
  if (-not $sumAsset) { throw 'The latest release has no SHA-256 file. Aborting for safety.' }

  $temp = Join-Path ([System.IO.Path]::GetTempPath()) ("acc-install-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null

  try {
    $zipPath = Join-Path $temp $zipAsset.name
    Write-Host "Downloading $($zipAsset.name) ($version)..."
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $zipPath -UseBasicParsing
    $sumResponse = Invoke-WebRequest -Uri $sumAsset.browser_download_url -UseBasicParsing
    $sumText = if ($sumResponse.Content -is [byte[]]) {
      [System.Text.Encoding]::UTF8.GetString($sumResponse.Content)
    } else {
      [string]$sumResponse.Content
    }
    $expected = ($sumText.Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
      throw "The SHA-256 file has an unexpected format: $expected"
    }
    if ($expected -ne $actual) {
      throw "SHA-256 mismatch. Expected $expected, got $actual."
    }
    Write-Host "SHA-256 verified: $actual"

    $extractDir = Join-Path $temp 'app'
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
    $source = Join-Path $extractDir 'alice-control-center'
    if (-not (Test-Path $source)) {
      $candidates = @(Get-ChildItem -Path $extractDir -Directory)
      if ($candidates.Count -ne 1) { throw 'Unexpected archive layout.' }
      $source = $candidates[0].FullName
    }
    if (-not (Test-Path (Join-Path $source 'scripts\acc-start.ps1'))) {
      throw 'The archive does not look like Alice Control Center.'
    }

    Stop-RunningPanel

    Write-Host "Installing to $installDir..."
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    foreach ($folder in 'dist', 'src', 'server', 'shared', 'public', 'tests', 'docs', 'scripts') {
      $target = Join-Path $installDir $folder
      if (Test-Path $target) { Remove-Item -Path $target -Recurse -Force }
    }
    Copy-Item -Path (Join-Path $source '*') -Destination $installDir -Recurse -Force

    Push-Location $installDir
    try {
      Write-Host 'Installing dependencies...'
      $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
      if ($npm) {
        & $npm.Source install --no-audit --no-fund
      } else {
        cmd /c "npm install --no-audit --no-fund"
      }
      if ($LASTEXITCODE -ne 0) { throw "npm install failed with code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }

    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop 'Alice Control Center.lnk'
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershellExe
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installDir\scripts\acc-start.ps1`" -Silent"
    $shortcut.WorkingDirectory = $installDir
    $shortcut.IconLocation = "$installDir\public\acc.ico,0"
    $shortcut.Description = 'Launch Alice Control Center'
    $shortcut.Save()
    Write-Host "Desktop shortcut: $shortcutPath"

    Write-Host 'Starting the panel...'
    Start-Process -FilePath $powershellExe `
      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$installDir\scripts\acc-start.ps1`" -Silent" `
      -WindowStyle Hidden

    Write-Host ''
    Write-Host "Alice Control Center $version is installed." -ForegroundColor Green
    Write-Host "Folder:   $installDir"
    Write-Host 'Panel:    http://127.0.0.1:8722'
    Write-Host 'Tray:     right-click the tray icon for status, start, stop and updates.'
    Write-Host 'The panel listens on 127.0.0.1 only.'
  } finally {
    if (Test-Path $temp) { Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

try {
  Install-AliceControlCenter
} catch {
  Write-Host ''
  Write-Host "Installation failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'The station was not changed. Fix the problem and run the installer again.'
}

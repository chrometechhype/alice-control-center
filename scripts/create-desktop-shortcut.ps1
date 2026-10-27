$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$launcher = Join-Path $root 'scripts\acc-start.ps1'
$icon = Join-Path $root 'public\acc.ico'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path $launcher)) {
  throw "scripts\acc-start.ps1 not found in $root"
}

$shell = New-Object -ComObject WScript.Shell
$path = Join-Path $desktop 'Alice Control Center.lnk'
$shortcut = $shell.CreateShortcut($path)
$shortcut.TargetPath = $powershell
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -Silent"
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'Launch Alice Control Center'
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "Shortcut created: $path"

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$target = Join-Path $root 'start.bat'
$icon = Join-Path $root 'public\acc.ico'

if (-not (Test-Path $target)) {
  throw "start.bat not found in $root"
}

$shell = New-Object -ComObject WScript.Shell
$path = Join-Path $desktop 'Alice Control Center.lnk'
$shortcut = $shell.CreateShortcut($path)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = 'Launch Alice Control Center'
$shortcut.WindowStyle = 1
$shortcut.Save()

Write-Host "Shortcut created: $path"

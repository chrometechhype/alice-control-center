param(
  [ValidateSet('run', 'status', 'start', 'stop', 'restart', 'open', 'check', 'version')]
  [string]$Action = 'run'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'acc-common.ps1')

function Get-AccTrayState {
  $health = Get-AccHealth
  if ($health -and $health.ok) {
    $data = $health.data
    return [pscustomobject]@{
      Running    = $true
      Connection = if ($data.connection) { [string]$data.connection } else { 'unknown' }
      Version    = if ($data.version) { [string]$data.version } else { $null }
    }
  }
  return [pscustomobject]@{ Running = $false; Connection = ''; Version = (Get-AccVersion) }
}

function Invoke-AccUpdateCheck {
  $result = Check-AccUpdates
  if (-not $result -or -not $result.ok) {
    return [pscustomobject]@{
      Status  = 'error'
      Current = $null
      Message = 'Сервер не ответил на запрос обновлений.'
    }
  }
  if ($result.data.checkError) {
    return [pscustomobject]@{
      Status  = 'error'
      Current = [string]$result.data.currentVersion
      Message = [string]$result.data.checkError
    }
  }
  if ($result.data.updateAvailable) {
    return [pscustomobject]@{
      Status  = 'available'
      Current = [string]$result.data.currentVersion
      Message = "Доступна версия $($result.data.latestVersion)."
    }
  }
  return [pscustomobject]@{
    Status  = 'current'
    Current = [string]$result.data.currentVersion
    Message = "Установлена последняя версия $($result.data.currentVersion)."
  }
}

if ($Action -ne 'run') {
  if ($Action -eq 'status') {
    $state = Get-AccTrayState
    $running = if ($state.Running) { 'true' } else { 'false' }
    Write-Output ("running={0}; connection={1}; version={2}" -f $running, $state.Connection, $state.Version)
    if (-not $state.Running) { exit 3 }
    if ($state.Connection -eq 'connected') { exit 0 }
    exit 2
  }
  if ($Action -eq 'start') {
    if (Start-AccBackend) { exit 0 } else { exit 1 }
  }
  if ($Action -eq 'stop') {
    if (Stop-AccBackend) { exit 0 } else { exit 1 }
  }
  if ($Action -eq 'restart') {
    if (Restart-AccBackend) { exit 0 } else { exit 1 }
  }
  if ($Action -eq 'open') {
    Open-AccPanel
    exit 0
  }
  if ($Action -eq 'version') {
    Write-Output (Get-AccVersion)
    exit 0
  }
  if ($Action -eq 'check') {
    $update = Invoke-AccUpdateCheck
    Write-Output ("{0}: {1}" -f $update.Status, $update.Message)
    if ($update.Status -eq 'error') { exit 1 }
    if ($update.Status -eq 'available') { exit 10 }
    exit 0
  }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$mutex = New-Object System.Threading.Mutex($false, 'Local\AliceControlCenterTray')
$owned = $false
try {
  $owned = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $owned = $true
}
if (-not $owned) { exit 0 }

$root = Get-AccRoot

function Get-AccIcon([string]$name) {
  $path = Join-Path $root "public\$name"
  if (Test-Path $path) {
    try { return New-Object System.Drawing.Icon($path) } catch { }
  }
  return [System.Drawing.SystemIcons]::Application
}

$iconOn = Get-AccIcon 'acc-on.ico'
$iconBusy = Get-AccIcon 'acc-busy.ico'
$iconOff = Get-AccIcon 'acc-off.ico'

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconOff
$notify.Text = 'Alice Control Center'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$notify.ContextMenuStrip = $menu

function Add-AccMenu([string]$text) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $text
  [void]$menu.Items.Add($item)
  return $item
}

function Add-AccSeparator {
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
}

$statusItem = Add-AccMenu 'Статус: проверка…'
$statusItem.Enabled = $false
$versionItem = Add-AccMenu 'Версия: …'
$versionItem.Enabled = $false
Add-AccSeparator
$openItem = Add-AccMenu 'Открыть панель'
$startItem = Add-AccMenu 'Запустить панель'
$stopItem = Add-AccMenu 'Остановить панель'
$restartItem = Add-AccMenu 'Перезапустить панель'
Add-AccSeparator
$checkItem = Add-AccMenu 'Проверить обновления'
$folderItem = Add-AccMenu 'Открыть папку панели'
$logItem = Add-AccMenu 'Журнал сервера'
Add-AccSeparator
$hideItem = Add-AccMenu 'Скрыть значок'
$exitItem = Add-AccMenu 'Остановить панель и выйти'

$script:accRunning = $false
$script:accConnection = ''
$script:accVersion = $null
$script:accIconName = 'off'

function Show-AccBalloon([string]$title, [string]$message, [string]$kind = 'Info') {
  $notify.BalloonTipTitle = $title
  $notify.BalloonTipText = $message
  $notify.BalloonTipIcon = switch ($kind) {
    'Error' { [System.Windows.Forms.ToolTipIcon]::Error }
    'Warning' { [System.Windows.Forms.ToolTipIcon]::Warning }
    default { [System.Windows.Forms.ToolTipIcon]::Info }
  }
  $notify.ShowBalloonTip(4000)
}

function Update-AccTrayDisplay {
  $state = Get-AccTrayState
  $script:accRunning = $state.Running
  $script:accConnection = $state.Connection
  $script:accVersion = $state.Version

  if (-not $state.Running) {
    $icon = $iconOff
    $iconName = 'off'
    $status = 'Панель остановлена'
  } elseif ($state.Connection -eq 'connected') {
    $icon = $iconOn
    $iconName = 'on'
    $status = 'Подключено к станции'
  } else {
    $icon = $iconBusy
    $iconName = 'busy'
    $status = 'Станция не подключена'
  }

  if ($script:accIconName -ne $iconName) {
    $script:accIconName = $iconName
    $notify.Icon = $icon
  }

  $version = if ($script:accVersion) { " · v$($script:accVersion)" } else { '' }
  $text = "Alice Control Center — $status$version"
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $notify.Text = $text

  $statusItem.Text = "Статус: $status"
  $versionItem.Text = if ($script:accVersion) { "Версия $($script:accVersion)" } else { 'Версия не определена' }
  $openItem.Enabled = $state.Running
  $startItem.Enabled = -not $state.Running
  $stopItem.Enabled = $state.Running
  $restartItem.Enabled = $state.Running
  $checkItem.Enabled = $state.Running
}

function Start-AccFromTray {
  if ($script:accRunning) {
    Open-AccPanel
    return
  }
  $notify.Text = 'Alice Control Center — запуск…'
  if (Start-AccBackend) {
    Update-AccTrayDisplay
    Open-AccPanel
  } else {
    Update-AccTrayDisplay
    Show-AccBalloon 'Не удалось запустить' 'Проверьте data\logs\server-error.log.' 'Error'
  }
}

$openItem.add_Click({ Open-AccPanel })
$startItem.add_Click({ Start-AccFromTray })
$stopItem.add_Click({
    if (Stop-AccBackend) {
      Update-AccTrayDisplay
      Show-AccBalloon 'Панель остановлена' 'Backend завершён. Станция не затронута.'
    } else {
      Show-AccBalloon 'Не удалось остановить' 'Процесс на порту 8722 не является панелью ACC.' 'Error'
    }
  })
$restartItem.add_Click({
    if (Restart-AccBackend) {
      Update-AccTrayDisplay
      Show-AccBalloon 'Панель перезапущена' 'Интерфейс снова доступен на 127.0.0.1:8722.'
    } else {
      Update-AccTrayDisplay
      Show-AccBalloon 'Не удалось перезапустить' 'Проверьте data\logs\server-error.log.' 'Error'
    }
  })
$checkItem.add_Click({
    $update = Invoke-AccUpdateCheck
    if ($update.Status -eq 'available') {
      Show-AccBalloon 'Доступно обновление' "$($update.Message) Установите его в панели: Настройки → Обновления."
    } elseif ($update.Status -eq 'current') {
      Show-AccBalloon 'Обновлений нет' $update.Message
    } else {
      Show-AccBalloon 'Не удалось проверить обновления' $update.Message 'Error'
    }
  })
$folderItem.add_Click({ Start-Process -FilePath explorer.exe -ArgumentList "`"$root`"" })
$logItem.add_Click({
    $log = Join-Path $root 'data\logs\server.log'
    if (Test-Path $log) {
      Start-Process -FilePath notepad.exe -ArgumentList "`"$log`""
    } else {
      Show-AccBalloon 'Журнал пуст' 'Файл data\logs\server.log ещё не создан.'
    }
  })
$hideItem.add_Click({
    $notify.Visible = $false
    [System.Windows.Forms.Application]::ExitThread()
  })
$exitItem.add_Click({
    Stop-AccBackend | Out-Null
    $notify.Visible = $false
    [System.Windows.Forms.Application]::ExitThread()
  })
$notify.add_MouseDoubleClick({ Start-AccFromTray })

Update-AccTrayDisplay
$notify.Visible = $true

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ Update-AccTrayDisplay })
$timer.Start()

[System.Windows.Forms.Application]::Run()

$timer.Stop()
$timer.Dispose()
$notify.Visible = $false
$notify.Dispose()
$menu.Dispose()
try { $mutex.ReleaseMutex() } catch { }
$mutex.Dispose()

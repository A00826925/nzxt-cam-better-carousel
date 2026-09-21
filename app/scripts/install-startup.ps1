<#
  Makes Kraken Host start at login, with admin rights (needed to read the CPU temperature
  through the PawnIO driver), via a Task Scheduler entry - so there is no UAC prompt at login.

  Usage (from the app folder):  powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 [-StartNow]
  Undo:                          powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1
#>
param(
  [switch]$StartNow,
  [string]$ForUser = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = 'Stop'
$taskName = 'Kraken Host'

# Creating a task that runs elevated needs admin: relaunch elevated once, for the same user.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-ForUser', "`"$ForUser`"")
  if ($StartNow) { $args += '-StartNow' }
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList $args
  exit
}

$app = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Host "Electron isn't installed yet. Run 'npm install' in $app first." -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
if (-not (Test-Path (Join-Path $app 'sensors\bin\publish\KrakenSensors.exe'))) {
  Write-Host "Note: the sensor helper isn't built, so CPU/GPU temperatures will show '-'. Run 'npm run build-sensors'." -ForegroundColor Yellow
}

$action    = New-ScheduledTaskAction -Execute $electron -Argument "`"$app`"" -WorkingDirectory $app
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $ForUser
$trigger.Delay = 'PT10S'   # give USB devices a moment after login
$principal = New-ScheduledTaskPrincipal -UserId $ForUser -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
  -Settings $settings -Description 'Shows the carousel on the NZXT Kraken LCD (display only).' -Force | Out-Null
Write-Host "Kraken Host will start at login for $ForUser."

if ($StartNow) {
  Start-ScheduledTask -TaskName $taskName
  Write-Host 'Started.'
}

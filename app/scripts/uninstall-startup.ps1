<#
  Removes the "Kraken Host" login task created by install-startup.ps1 (and stops it if running).
  Usage: powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1
#>
$ErrorActionPreference = 'Stop'
$taskName = 'Kraken Host'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit
}

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host 'Kraken Host will no longer start at login.'
} else {
  Write-Host 'Kraken Host was not set to start at login.'
}

<#
.SYNOPSIS
  Build & flash the ROBOT firmware (ESP32, PlatformIO / Arduino).

.PARAMETER Port
  Target a specific serial port, e.g. COM5. Otherwise PlatformIO auto-detects.

.PARAMETER BuildOnly
  Compile without flashing.

.PARAMETER Monitor
  Open the serial monitor after flashing.

.EXAMPLE
  .\flash-robot.ps1
  .\flash-robot.ps1 -Port COM5
  .\flash-robot.ps1 -BuildOnly
  .\flash-robot.ps1 -Monitor

.NOTES
  Customize robot name / motor pins / Wi-Fi channel in
  firmware\esp32-robot\platformio.ini (build_flags).
#>
[CmdletBinding()]
param(
  [string]$Port,
  [switch]$BuildOnly,
  [switch]$Monitor
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Proj = Join-Path $Root 'firmware\esp32-robot'

if (-not (Get-Command pio -ErrorAction SilentlyContinue)) {
  Write-Host "[error] 'pio' not found. Run .\setup.ps1 first, then open a NEW terminal." -ForegroundColor Red
  exit 1
}

Push-Location $Proj
try {
  if ($BuildOnly) {
    & pio run
    exit $LASTEXITCODE
  }

  $uploadArgs = @('run', '-t', 'upload')
  if ($Port) { $uploadArgs += @('--upload-port', $Port) }
  & pio @uploadArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if ($Monitor) { & pio device monitor }
}
finally {
  Pop-Location
}

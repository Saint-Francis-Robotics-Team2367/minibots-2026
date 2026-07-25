<#
.SYNOPSIS
  Build & flash the DONGLE firmware (ESP32-S3, ESP-IDF).

.PARAMETER Port
  Target a specific serial port, e.g. COM7. Otherwise idf.py auto-detects.

.PARAMETER BuildOnly
  Compile without flashing.

.PARAMETER Monitor
  Open the serial monitor after flashing.

.EXAMPLE
  .\flash-dongle.ps1
  .\flash-dongle.ps1 -Port COM7
  .\flash-dongle.ps1 -BuildOnly
  .\flash-dongle.ps1 -Monitor

.NOTES
  ESP-IDF is auto-sourced from .\.esp-idf (installed by .\setup.ps1). To use a
  system ESP-IDF instead, set $env:IDF_PATH before running.

  USB download mode (if flashing fails): hold BOOT, press+release RESET,
  release BOOT, then re-run.
#>
[CmdletBinding()]
param(
  [string]$Port,
  [switch]$BuildOnly,
  [switch]$Monitor
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Proj = Join-Path $Root 'firmware\esp32s3-dongle'

# --- locate & source ESP-IDF (export.ps1 puts idf.py + tools on PATH) ---
if (-not (Get-Command idf.py -ErrorAction SilentlyContinue)) {
  $export = $null
  if ($env:IDF_PATH -and (Test-Path (Join-Path $env:IDF_PATH 'export.ps1'))) {
    $export = Join-Path $env:IDF_PATH 'export.ps1'
  } elseif (Test-Path (Join-Path $Root '.esp-idf\export.ps1')) {
    $export = Join-Path $Root '.esp-idf\export.ps1'
  }
  if (-not $export) {
    Write-Host '[error] ESP-IDF not found. Run .\setup.ps1 first, or set $env:IDF_PATH.' -ForegroundColor Red
    exit 1
  }
  # export.ps1 expects IDF_PATH to point at the SDK tree.
  if (-not $env:IDF_PATH) { $env:IDF_PATH = Split-Path -Parent $export }
  . $export
}

Push-Location $Proj
try {
  & idf.py set-target esp32s3   # no-op once configured; ensures fresh clones build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & idf.py build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if ($BuildOnly) { exit 0 }

  $targets = @()
  if ($Port) { $targets += @('-p', $Port) }
  $targets += 'flash'
  if ($Monitor) { $targets += 'monitor' }
  & idf.py @targets
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}

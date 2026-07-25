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

# Keep the window open if double-clicked / "Run with PowerShell", so errors
# are readable instead of flashing and vanishing.
function Pause-IfInteractive {
  if ([Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost') {
    Read-Host 'Press Enter to close'
  }
}
trap {
  Write-Host ''
  Write-Host "[error] $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
  Pause-IfInteractive
  exit 1
}

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
    throw 'ESP-IDF not found. Run .\setup.ps1 first, or set $env:IDF_PATH.'
  }
  # export.ps1 expects IDF_PATH to point at the SDK tree.
  if (-not $env:IDF_PATH) { $env:IDF_PATH = Split-Path -Parent $export }
  . $export
}

Push-Location $Proj
try {
  & idf.py set-target esp32s3   # no-op once configured; ensures fresh clones build
  if ($LASTEXITCODE -ne 0) { throw "idf.py set-target failed (exit $LASTEXITCODE)." }
  & idf.py build
  if ($LASTEXITCODE -ne 0) { throw "idf.py build failed (exit $LASTEXITCODE)." }

  if ($BuildOnly) { return }

  $targets = @()
  if ($Port) { $targets += @('-p', $Port) }
  $targets += 'flash'
  if ($Monitor) { $targets += 'monitor' }
  & idf.py @targets
  if ($LASTEXITCODE -ne 0) { throw "idf.py $($targets -join ' ') failed (exit $LASTEXITCODE)." }
}
finally {
  Pop-Location
}

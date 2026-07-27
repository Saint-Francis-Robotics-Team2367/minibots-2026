<#
.SYNOPSIS
  Build & flash the DONGLE firmware (ESP32-S3, ESP-IDF).

.PARAMETER Port
  Target a specific serial port, e.g. COM7. Otherwise idf.py auto-detects.

.PARAMETER BuildOnly
  Compile without flashing.

.PARAMETER Monitor
  Open the serial monitor after flashing.

.PARAMETER SkipSetup
  Assume ESP-IDF is already installed/sourced; don't clone or install it.

.EXAMPLE
  .\scripts\flash-dongle.ps1
  .\scripts\flash-dongle.ps1 -Port COM7
  .\scripts\flash-dongle.ps1 -BuildOnly
  .\scripts\flash-dongle.ps1 -Monitor

.NOTES
  On first run this installs its own toolchain: it clones the pinned ESP-IDF
  v5.3.2 into .\.esp-idf (repo-local, git-ignored) and runs its installer — no
  separate setup step. Later runs just source that SDK and are fast. To use a
  system ESP-IDF instead, set $env:IDF_PATH before running.

  USB download mode (if flashing fails): hold BOOT, press+release RESET,
  release BOOT, then re-run.
#>
[CmdletBinding()]
param(
  [string]$Port,
  [switch]$BuildOnly,
  [switch]$Monitor,
  [switch]$SkipSetup
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

# --- version pin (keep in sync with firmware\esp32s3-dongle\dependencies.lock) ---
$IdfVersion = 'v5.3.2'

$Root   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Proj   = Join-Path $Root 'firmware\esp32s3-dongle'
$IdfDir = Join-Path $Root '.esp-idf'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# --- ensure the repo-local ESP-IDF exists (first-run setup, then a no-op) ---
function Ensure-Idf {
  if (-not (Have git)) { throw 'git not found. Install Git for Windows (https://git-scm.com) and re-run.' }

  $Python = $null
  foreach ($c in 'python','python3','py') { if (Have $c) { $Python = $c; break } }
  if (-not $Python) { throw 'Python not found. Install Python 3.11 (https://python.org, check "Add to PATH") and re-run.' }

  # ESP-IDF v5.3.2 (2024) is tested against Python 3.9-3.12; its pinned tooling can
  # fail to install on 3.13+. Require the supported range, recommend 3.11.
  $pyVer = & $Python -c 'import sys; print("%d.%d" % sys.version_info[:2])'
  $pyMajor = [int]($pyVer.Split('.')[0]); $pyMinor = [int]($pyVer.Split('.')[1])
  if ($env:MINICORE_SKIP_PYCHECK -eq '1') {
    Warn "Skipping Python version check (MINICORE_SKIP_PYCHECK=1); using $pyVer."
  } elseif ($pyMajor -ne 3 -or $pyMinor -lt 9 -or $pyMinor -gt 12) {
    throw @"
Python $pyVer is not supported by ESP-IDF v$($IdfVersion.TrimStart('v')).
       Use Python 3.9-3.12 (3.11 recommended). Install 3.11 from https://python.org
       (check "Add to PATH"), then re-run. ESP-IDF installs its own venv, so 3.11
       only needs to be on PATH here — it need not be your system default.
       Override at your own risk: `$env:MINICORE_SKIP_PYCHECK='1'
"@
  }

  if (-not (Have cmake)) {
    Warn 'cmake not found — required by ESP-IDF. Install with:  winget install Kitware.CMake'
  }

  if (Test-Path (Join-Path $IdfDir '.git')) {
    $current = (& git -C $IdfDir describe --tags) 2>$null
    if (-not $current) { $current = 'unknown' }
    Info "ESP-IDF already present at .esp-idf ($current)"
    if ($current -ne $IdfVersion) {
      Warn "Installed ESP-IDF is $current, project expects $IdfVersion."
      Warn 'Delete .esp-idf and re-run to switch versions.'
    }
  } else {
    Info "Cloning ESP-IDF $IdfVersion into .esp-idf (shallow; ~a few hundred MB)"
    # --shallow-submodules: depth-1 for every submodule, not just the main repo,
    #   avoiding full submodule history. -j 8: parallel submodule fetch.
    & git clone --branch $IdfVersion --depth 1 `
      --recurse-submodules --shallow-submodules -j 8 `
      https://github.com/espressif/esp-idf.git $IdfDir
    if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF clone failed.' }
  }

  Info 'Installing ESP-IDF tools for esp32s3 (compiler, openocd, etc.)'
  & (Join-Path $IdfDir 'install.bat') esp32s3
  if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF install.bat failed.' }
}

# --- locate & source ESP-IDF (installing it on first run; export.ps1 puts idf.py + tools on PATH) ---
if (-not (Have idf.py)) {
  $export = $null
  if ($env:IDF_PATH -and (Test-Path (Join-Path $env:IDF_PATH 'export.ps1'))) {
    $export = Join-Path $env:IDF_PATH 'export.ps1'
  } else {
    if (-not (Test-Path (Join-Path $IdfDir 'export.ps1'))) {
      if ($SkipSetup) { throw 'ESP-IDF not found and -SkipSetup given. Set $env:IDF_PATH or drop -SkipSetup.' }
      Ensure-Idf
    }
    $export = Join-Path $IdfDir 'export.ps1'
  }
  if (-not (Test-Path $export)) { throw "ESP-IDF export script not found at $export." }
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

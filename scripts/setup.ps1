<#
.SYNOPSIS
  minibots-2026 — one-shot toolchain bootstrap (Windows / PowerShell).

.DESCRIPTION
  Windows equivalent of setup.sh. Installs everything needed to build & flash
  BOTH firmwares from a fresh machine:
    * esptool + mpremote -> robot  (firmware/esp32-robot, MicroPython)
    * ESP-IDF v5.3.2     -> dongle firmware (firmware/esp32s3-dongle, ESP32-S3)

  ESP-IDF is cloned into .\.esp-idf (repo-local, git-ignored). Re-running is
  safe and idempotent. After this finishes, use:
    .\scripts\flash-robot.ps1      .\scripts\flash-dongle.ps1

.EXAMPLE
  # From a PowerShell prompt in the repo root:
  .\scripts\setup.ps1

  # If script execution is blocked, launch with:
  powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Keep the window open if the script was double-clicked / "Run with PowerShell",
# so errors are readable instead of flashing and vanishing.
function Pause-IfInteractive {
  # Only pause when running in an interactive console (double-click / Run with
  # PowerShell). Skip when piped, redirected, or non-interactive (e.g. CI).
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

# --- version pin (keep in sync with firmware/esp32s3-dongle/dependencies.lock) ---
$IdfVersion = 'v5.3.2'

$Root   = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$IdfDir = Join-Path $Root '.esp-idf'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Die($m)  { throw $m }   # caught by trap above -> prints + pauses
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# -----------------------------------------------------------------------------
# 0. Prerequisites: git, python, cmake
# -----------------------------------------------------------------------------
Info 'Checking prerequisites'
if (-not (Have git))    { Die 'git not found. Install Git for Windows (https://git-scm.com) and re-run.' }

$Python = $null
foreach ($c in 'python','python3','py') { if (Have $c) { $Python = $c; break } }
if (-not $Python) { Die 'Python not found. Install Python 3.11 (https://python.org, check "Add to PATH") and re-run.' }

# ESP-IDF v5.3.2 (2024) is tested against Python 3.9-3.12; its pinned tooling can
# fail to install on 3.13+. Require the supported range, recommend 3.11.
$pyVer = & $Python -c 'import sys; print("%d.%d" % sys.version_info[:2])'
$pyMajor = [int]($pyVer.Split('.')[0]); $pyMinor = [int]($pyVer.Split('.')[1])
if ($env:MINICORE_SKIP_PYCHECK -eq '1') {
  Warn "Skipping Python version check (MINICORE_SKIP_PYCHECK=1); using $pyVer."
} elseif ($pyMajor -ne 3 -or $pyMinor -lt 9 -or $pyMinor -gt 12) {
  Die @"
Python $pyVer is not supported by ESP-IDF v$($IdfVersion.TrimStart('v')).
       Use Python 3.9-3.12 (3.11 recommended). Install 3.11 from https://python.org
       (check "Add to PATH"), then re-run. ESP-IDF installs its own venv, so 3.11
       only needs to be on PATH here — it need not be your system default.
       Override at your own risk: `$env:MINICORE_SKIP_PYCHECK='1'
"@
} else {
  Info "Python $pyVer OK"
}

if (-not (Have cmake)) {
  Warn 'cmake not found — required by ESP-IDF. Install with:  winget install Kitware.CMake'
}

# -----------------------------------------------------------------------------
# 1. esptool + mpremote (robot firmware — MicroPython)
# -----------------------------------------------------------------------------
if (((Have esptool.py) -or (Have esptool)) -and (Have mpremote)) {
  Info 'esptool + mpremote already installed'
} else {
  Info 'Installing esptool + mpremote via pip (MicroPython flash + upload tools)'
  & $Python -m pip install --user --upgrade esptool mpremote
  if ($LASTEXITCODE -ne 0) { Die "pip install esptool mpremote failed. Try:  $Python -m pip install --user esptool mpremote" }
  if (-not (Have mpremote)) {
    Warn "'mpremote' is not on PATH yet. Add your Python user Scripts dir to PATH, e.g.:"
    Warn '  %APPDATA%\Python\Python3X\Scripts   (see the pip install output above for the exact path)'
    Warn 'Then open a NEW terminal before running the flash scripts.'
  }
}

# -----------------------------------------------------------------------------
# 2. ESP-IDF (dongle firmware) — clone pinned version + run installer
# -----------------------------------------------------------------------------
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
  if ($LASTEXITCODE -ne 0) { Die 'ESP-IDF clone failed.' }
}

Info 'Installing ESP-IDF tools for esp32s3 (compiler, openocd, etc.)'
& (Join-Path $IdfDir 'install.bat') esp32s3
if ($LASTEXITCODE -ne 0) { Die 'ESP-IDF install.bat failed.' }

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host ''
Write-Host 'Flash the robot (ESP32, MicroPython):'
Write-Host '    .\scripts\flash-robot.ps1 -Firmware   # one-time: install MicroPython'
Write-Host '    .\scripts\flash-robot.ps1             # upload your main.py'
Write-Host '  (download the MicroPython .bin first — see firmware\esp32-robot\micropython\README.md)'
Write-Host ''
Write-Host 'Build & flash the dongle (ESP32-S3, ESP-IDF):'
Write-Host '    .\scripts\flash-dongle.ps1'
Write-Host ''
Write-Host 'The dongle script auto-sources ESP-IDF from .esp-idf — no manual export needed.'
Pause-IfInteractive

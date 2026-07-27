<#
.SYNOPSIS
  Flash the ROBOT (ESP32, MicroPython).

.DESCRIPTION
  Two modes:
    .\scripts\flash-robot.ps1 -Firmware     ONE-TIME: install MicroPython onto the board
    .\scripts\flash-robot.ps1               upload student code (main.py + minibot.py) & reboot

.PARAMETER Port
  Target a specific serial port, e.g. COM5. Otherwise esptool/mpremote auto-detect.

.PARAMETER Firmware
  Erase + write the MicroPython .bin from
  firmware\esp32-robot\micropython\ESP32_GENERIC-*.bin

.PARAMETER Repl
  Open a live MicroPython prompt (see print() output).

.PARAMETER SkipSetup
  Don't check/install esptool + mpremote before flashing.

.EXAMPLE
  .\scripts\flash-robot.ps1 -Firmware
  .\scripts\flash-robot.ps1
  .\scripts\flash-robot.ps1 -Port COM5
  .\scripts\flash-robot.ps1 -Repl

.NOTES
  On first run this installs its own tools (esptool + mpremote) into a private
  virtualenv at .venv-flash\ -- no separate setup step, nothing installed
  system-wide, and no PATH changes required. The check is idempotent, so later
  runs are instant.

  Students edit firmware\esp32-robot\main.py, then run .\scripts\flash-robot.ps1.
#>
[CmdletBinding()]
param(
  [string]$Port,
  [switch]$Firmware,
  [switch]$Repl,
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

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Proj = Join-Path $Root 'firmware\esp32-robot'
$MpyDir = Join-Path $Proj 'micropython'
$VenvDir = Join-Path $Root '.venv-flash'

# Pinned MicroPython firmware for the classic ESP32 (auto-downloaded by
# -Firmware if not already present in $MpyDir). Keep in sync with
# firmware\esp32-robot\micropython\README.md.
$MpyBinName   = 'ESP32_GENERIC-20260406-v1.28.0.bin'
$MpyBinUrl    = "https://micropython.org/resources/firmware/$MpyBinName"
$MpyBinSha256 = 'cd7820d02c35d34dd403b44263129c6a511b350aea8446c229890753fe240784'

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# The venv's python (Windows puts it under Scripts\). Everything runs through
# this as `python -m ...`, so no console-script shim or PATH entry is needed.
$PyBin = Join-Path $VenvDir 'Scripts\python.exe'

# True if the venv python can already import both tools.
function Tools-Ready {
  if (-not (Test-Path $PyBin)) { return $false }
  & $PyBin -c 'import esptool, mpremote' *> $null
  return ($LASTEXITCODE -eq 0)
}

# --- ensure flash tools (esptool + mpremote) -- first-run setup, then a no-op ---
function Ensure-Tools {
  if (Tools-Ready) { return }

  $Python = $null
  foreach ($c in 'py','python','python3') { if (Have $c) { $Python = $c; break } }
  if (-not $Python) {
    throw 'Python not found. Install Python 3 (https://python.org, check "Add to PATH") and re-run (needed to install esptool + mpremote).'
  }

  if (-not (Test-Path $PyBin)) {
    Write-Host "[info] Creating tool virtualenv at $VenvDir (one time)"
    & $Python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to create virtualenv at $VenvDir with '$Python -m venv'." }
  }

  Write-Host '[info] Installing esptool + mpremote (one time)'
  & $PyBin -m pip install --quiet --upgrade pip *> $null
  & $PyBin -m pip install --upgrade esptool mpremote
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install esptool + mpremote into $VenvDir. Retry, or run manually:  `"$PyBin`" -m pip install esptool mpremote"
  }

  if (-not (Tools-Ready)) { throw "esptool/mpremote still not importable from $VenvDir after install." }
}

if (-not $SkipSetup) { Ensure-Tools }

if (-not (Tools-Ready)) { throw 'esptool + mpremote unavailable. Re-run without -SkipSetup to install them.' }

# Invoke the tools as modules through the venv python -- never via PATH.
# Splat these after $PyBin, e.g.  & $PyBin @EsptoolArgs --chip esp32 ...
$EsptoolArgs  = @('-m', 'esptool')
$MpremoteArgs = @('-m', 'mpremote')

# mpremote device selector
$MprDev = @()
if ($Port) { $MprDev = @('connect', $Port) }

if ($Repl) {
  & $PyBin @MpremoteArgs @MprDev repl
  return
}

if ($Firmware) {
  $Bin = Get-ChildItem -Path (Join-Path $MpyDir 'ESP32_GENERIC-*.bin') -ErrorAction SilentlyContinue |
         Sort-Object Name | Select-Object -Last 1

  # No firmware image yet? Download the pinned one automatically (verified by
  # SHA256), so the user never has to fetch it by hand.
  if (-not $Bin) {
    if (-not (Test-Path $MpyDir)) { New-Item -ItemType Directory -Path $MpyDir -Force | Out-Null }
    $dest = Join-Path $MpyDir $MpyBinName
    Write-Host "[info] No firmware image found. Downloading MicroPython $MpyBinName (one time)"
    try {
      $ProgressPreference = 'SilentlyContinue'  # faster, quieter download
      Invoke-WebRequest -Uri $MpyBinUrl -OutFile $dest -UseBasicParsing
    } catch {
      throw "Could not download the firmware automatically ($($_.Exception.Message)). " +
            "Download $MpyBinName from https://micropython.org/download/ESP32_GENERIC/ " +
            "and place it in $MpyDir (see its README.md), then re-run."
    }
    $got = (Get-FileHash -Path $dest -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $MpyBinSha256) {
      Remove-Item -Path $dest -Force -ErrorAction SilentlyContinue
      throw "Firmware SHA256 mismatch: got $got, expected $MpyBinSha256. Download aborted; please re-run."
    }
    Write-Host "[info] Downloaded and verified $((Get-Item $dest).Length) bytes"
    $Bin = Get-Item $dest
  }

  $portArgs = @()
  if ($Port) { $portArgs = @('--port', $Port) }
  Write-Host "[info] Flashing MicroPython: $($Bin.Name)"
  & $PyBin @EsptoolArgs --chip esp32 @portArgs erase_flash
  if ($LASTEXITCODE -ne 0) { throw "esptool erase_flash failed (exit $LASTEXITCODE)." }
  & $PyBin @EsptoolArgs --chip esp32 @portArgs write_flash -z 0x1000 $Bin.FullName
  if ($LASTEXITCODE -ne 0) { throw "esptool write_flash failed (exit $LASTEXITCODE)." }
  Write-Host "[info] MicroPython installed. Now run .\scripts\flash-robot.ps1 to upload your code."
  return
}

# Default: upload student code and reboot into it.
#
# Opening the serial port resets the ESP32, so mpremote's Ctrl-C to break into
# the REPL races against the robot's boot + Wi-Fi/ESP-NOW init (during which
# Python can't be interrupted). When it loses that race you get
# "could not enter raw repl". Retrying re-runs the race and one attempt lands
# while the board is interruptible, so a small bounded retry loop is reliable.
Write-Host "[info] Uploading main.py + minibot.py"
$UploadTries = 5
$uploaded = $false
for ($try = 1; $try -le $UploadTries; $try++) {
  & $PyBin @MpremoteArgs @MprDev fs cp (Join-Path $Proj 'minibot.py') (Join-Path $Proj 'main.py') :
  if ($LASTEXITCODE -eq 0) { $uploaded = $true; break }
  if ($try -lt $UploadTries) {
    Write-Host "[warn] Couldn't reach the board (attempt $try/$UploadTries); the running program may be blocking the REPL. Retrying..." -ForegroundColor Yellow
    Start-Sleep -Seconds 1
  }
}

if (-not $uploaded) {
  throw "Could not upload after $UploadTries tries: mpremote can't interrupt the program running on the robot. " +
        "Try again - if it keeps failing, hold the board's BOOT button while you start this script, " +
        "or reflash the MicroPython runtime with:  .\scripts\flash-robot.ps1 -Firmware"
}

& $PyBin @MpremoteArgs @MprDev reset
Write-Host "[info] Uploaded and reset. Use -Repl to watch output."

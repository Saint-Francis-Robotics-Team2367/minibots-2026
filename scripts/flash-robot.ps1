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
  On first run this installs its own tools (esptool + mpremote via pip) — no
  separate setup step. The check is idempotent, so later runs are instant.

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

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Have-Esptool { (Have esptool.py) -or (Have esptool) }

# --- ensure flash tools (esptool + mpremote) — first-run setup, then a no-op ---
function Ensure-Tools {
  if ((Have-Esptool) -and (Have mpremote)) { return }

  $Python = $null
  foreach ($c in 'python','python3','py') { if (Have $c) { $Python = $c; break } }
  if (-not $Python) {
    throw 'Python not found. Install Python 3 (https://python.org, check "Add to PATH") and re-run (needed to install esptool + mpremote).'
  }

  Write-Host '[info] Installing esptool + mpremote via pip (one time)'
  & $Python -m pip install --user --upgrade esptool mpremote
  if ($LASTEXITCODE -ne 0) { throw "pip install esptool mpremote failed. Try:  $Python -m pip install --user esptool mpremote" }

  # pip's --user Scripts dir may not be on PATH in this session yet; add it so
  # the freshly-installed tools are usable without opening a new terminal.
  if (-not (Have mpremote)) {
    $userBase = & $Python -c 'import site; print(site.getuserbase())' 2>$null
    if ($userBase) {
      $userScripts = Join-Path $userBase 'Scripts'
      if (Test-Path $userScripts) { $env:PATH = "$userScripts;$env:PATH" }
    }
  }
  if (-not (Have mpremote)) {
    throw "'mpremote' installed but not on PATH. Add your Python user Scripts dir to PATH " +
          '(e.g. %APPDATA%\Python\Python3X\Scripts — see the pip output above), then open a NEW terminal.'
  }
}

if (-not $SkipSetup) { Ensure-Tools }

if (-not (Have-Esptool)) { throw "'esptool' not found (try without -SkipSetup)." }
if (-not (Have mpremote)) { throw "'mpremote' not found (try without -SkipSetup)." }
$Esptool = if (Have esptool.py) { 'esptool.py' } else { 'esptool' }

# mpremote device selector
$MprDev = @()
if ($Port) { $MprDev = @('connect', $Port) }

if ($Repl) {
  & mpremote @MprDev repl
  return
}

if ($Firmware) {
  $Bin = Get-ChildItem -Path (Join-Path $MpyDir 'ESP32_GENERIC-*.bin') -ErrorAction SilentlyContinue |
         Sort-Object Name | Select-Object -Last 1
  if (-not $Bin) {
    throw "No ESP32_GENERIC-*.bin in $MpyDir. Download it from " +
          "https://micropython.org/download/ESP32_GENERIC/ (see $MpyDir\README.md) and place it there."
  }
  $portArgs = @()
  if ($Port) { $portArgs = @('--port', $Port) }
  Write-Host "[info] Flashing MicroPython: $($Bin.Name)"
  & $Esptool --chip esp32 @portArgs erase_flash
  if ($LASTEXITCODE -ne 0) { throw "esptool erase_flash failed (exit $LASTEXITCODE)." }
  & $Esptool --chip esp32 @portArgs write_flash -z 0x1000 $Bin.FullName
  if ($LASTEXITCODE -ne 0) { throw "esptool write_flash failed (exit $LASTEXITCODE)." }
  Write-Host "[info] MicroPython installed. Now run .\scripts\flash-robot.ps1 to upload your code."
  return
}

# Default: upload student code and reboot into it.
Write-Host "[info] Uploading main.py + minibot.py"
& mpremote @MprDev fs cp (Join-Path $Proj 'minibot.py') (Join-Path $Proj 'main.py') :
if ($LASTEXITCODE -ne 0) { throw "mpremote cp failed (exit $LASTEXITCODE)." }
& mpremote @MprDev reset
Write-Host "[info] Uploaded and reset. Use -Repl to watch output."

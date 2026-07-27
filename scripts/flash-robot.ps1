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

.EXAMPLE
  .\scripts\flash-robot.ps1 -Firmware
  .\scripts\flash-robot.ps1
  .\scripts\flash-robot.ps1 -Port COM5
  .\scripts\flash-robot.ps1 -Repl

.NOTES
  Students edit firmware\esp32-robot\main.py, then run .\scripts\flash-robot.ps1.
#>
[CmdletBinding()]
param(
  [string]$Port,
  [switch]$Firmware,
  [switch]$Repl
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

if (-not (Get-Command esptool.py -ErrorAction SilentlyContinue) -and
    -not (Get-Command esptool -ErrorAction SilentlyContinue)) {
  throw "'esptool' not found. Run .\scripts\setup.ps1 first, then open a NEW terminal."
}
if (-not (Get-Command mpremote -ErrorAction SilentlyContinue)) {
  throw "'mpremote' not found. Run .\scripts\setup.ps1 first, then open a NEW terminal."
}
$Esptool = if (Get-Command esptool.py -ErrorAction SilentlyContinue) { 'esptool.py' } else { 'esptool' }

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

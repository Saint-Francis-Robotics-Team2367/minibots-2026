<#
.SYNOPSIS
  Complete firmware RESET for the ROBOT (ESP32).

.DESCRIPTION
  Erases the board and reinstalls MicroPython from scratch. The firmware image
  is downloaded + verified automatically on first use. Do this once per robot,
  when upgrading MicroPython, or to recover a board that won't accept uploads.

  After this, run .\scripts\flash-robot.ps1 to upload your code.

  Thin wrapper around flash-robot.ps1 -Firmware so all the setup and flashing
  logic lives in one place.

.PARAMETER Port
  Target a specific serial port, e.g. COM5. Otherwise auto-detected.

.EXAMPLE
  .\scripts\reset-robot.ps1
  .\scripts\reset-robot.ps1 -Port COM5
#>
[CmdletBinding()]
param(
  [string]$Port,
  [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fwd = @{ Firmware = $true }
if ($Port) { $fwd['Port'] = $Port }
if ($SkipSetup) { $fwd['SkipSetup'] = $true }
& (Join-Path $here 'flash-robot.ps1') @fwd
exit $LASTEXITCODE

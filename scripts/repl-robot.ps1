<#
.SYNOPSIS
  Open a live MicroPython REPL on the ROBOT (ESP32).

.DESCRIPTION
  Gives you an interactive Python prompt on the board so you can see print()
  output and poke at things live. Press Ctrl-] (or Ctrl-X) to exit the REPL.

  Thin wrapper around flash-robot.ps1 -Repl so all the setup logic lives in
  one place.

.PARAMETER Port
  Target a specific serial port, e.g. COM5. Otherwise auto-detected.

.EXAMPLE
  .\scripts\repl-robot.ps1
  .\scripts\repl-robot.ps1 -Port COM5
#>
[CmdletBinding()]
param(
  [string]$Port,
  [switch]$SkipSetup
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$fwd = @{ Repl = $true }
if ($Port) { $fwd['Port'] = $Port }
if ($SkipSetup) { $fwd['SkipSetup'] = $true }
& (Join-Path $here 'flash-robot.ps1') @fwd
exit $LASTEXITCODE

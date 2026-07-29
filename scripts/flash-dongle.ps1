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

# Run an external tool (git/python/idf.py) and let the CALLER decide what a
# failure means, by checking $LASTEXITCODE afterwards.
#
# Needed because $ErrorActionPreference = 'Stop' above -- which we want for
# cmdlets -- also hijacks native commands: Windows PowerShell 5.1 turns *any*
# write to stderr into a terminating error (so a tool aborts the script merely
# by printing a warning or progress line), and PowerShell 7.3+ does the same for
# any non-zero exit code via $PSNativeCommandUseErrorActionPreference.
#
# The tool is launched here rather than via a caller-supplied scriptblock on
# purpose -- a scriptblock runs in a child scope of where it was *defined*, so
# it would never see these function-scoped preferences.
function Invoke-Tool {
  param(
    [Parameter(Mandatory, Position = 0)][string]$Exe,
    [Parameter(Position = 1)][string[]]$Arguments = @(),
    [switch]$Quiet   # discard stdout+stderr (probes, expected-to-fail calls)
  )
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  # Seed a failure code so a tool that can't even launch reads as "failed"
  # rather than inheriting the previous command's success.
  $global:LASTEXITCODE = 1
  if ($Quiet) { & $Exe @Arguments 2> $null } else { & $Exe @Arguments }
}

# ESP-IDF v5.3.2 (2024) is tested against Python 3.9-3.12; its pinned tooling can
# fail to install on 3.13+. Require the supported range, recommend 3.11.
$PyMinorMin = 9
$PyMinorMax = 12

# Find a Python that actually RUNS -- not merely one whose name resolves.
#
# Get-Command finds Windows' App Execution Aliases for 'python' and 'python3':
# stubs under %LOCALAPPDATA%\Microsoft\WindowsApps that exist on every machine
# and only open the Microsoft Store. They look exactly like a working Python and
# produce no output, so testing for mere existence and committing to the first
# name found aborted this script with an opaque "could not determine the version".
#
# Probe each candidate by running it, and prefer one whose version ESP-IDF
# supports. The 'py' launcher is tried first and with explicit versions, since it
# can reach a supported interpreter even when a too-new one owns bare 'python'.
function Find-Python {
  $probe = 'import sys; print("%d.%d" % sys.version_info[:2]); print(sys.executable)'

  $candidates = @()
  if (Have py) {
    foreach ($v in '3.12', '3.11', '3.10', '3.9') {
      $candidates += [pscustomobject]@{ Exe = 'py'; Pre = @("-$v") }
    }
    $candidates += [pscustomobject]@{ Exe = 'py'; Pre = @() }
  }
  foreach ($c in 'python', 'python3') {
    if (Have $c) { $candidates += [pscustomobject]@{ Exe = $c; Pre = @() } }
  }

  $result = [pscustomobject]@{ Supported = $null; Working = $null; Tried = $candidates.Count }

  foreach ($c in $candidates) {
    # -Quiet: a Store stub or a missing `py -3.x` writes to stderr, which is an
    # expected outcome of probing and must not surface as an error.
    $out = Invoke-Tool $c.Exe ($c.Pre + @('-c', $probe)) -Quiet
    if ($LASTEXITCODE -ne 0 -or -not $out) { continue }
    # Output may arrive as an array of lines or one embedded-newline string;
    # normalise both, and Trim() takes care of any trailing CR.
    $lines = @(@($out) | ForEach-Object { "$_" -split "`n" } |
               ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -lt 2 -or $lines[0] -notmatch '^\d+\.\d+$') { continue }

    $info = [pscustomobject]@{
      Exe     = $c.Exe
      Pre     = $c.Pre
      Version = $lines[0]
      Home    = Split-Path -Parent $lines[1]
      Label   = (@($c.Exe) + $c.Pre) -join ' '
    }
    if (-not $result.Working) { $result.Working = $info }

    $parts = $lines[0].Split('.')
    if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge $PyMinorMin -and [int]$parts[1] -le $PyMinorMax) {
      $result.Supported = $info
      break
    }
  }
  return $result
}

# --- ensure the repo-local ESP-IDF exists (first-run setup, then a no-op) ---
function Ensure-Idf {
  if (-not (Have git)) { throw 'git not found. Install Git for Windows (https://git-scm.com) and re-run.' }

  $py = Find-Python
  $chosen = $py.Supported
  if (-not $chosen) {
    if ($env:MINICORE_SKIP_PYCHECK -eq '1' -and $py.Working) {
      $chosen = $py.Working
      Warn "Skipping Python version check (MINICORE_SKIP_PYCHECK=1); using $($chosen.Version) ($($chosen.Label))."
    } elseif ($py.Working) {
      throw @"
Python $($py.Working.Version) ($($py.Working.Label)) is not supported by ESP-IDF v$($IdfVersion.TrimStart('v')).
       Use Python 3.$PyMinorMin-3.$PyMinorMax (3.11 recommended). Install 3.11 from
       https://python.org (check "Add to PATH"), then re-run. ESP-IDF installs its own
       venv, so 3.11 only needs to be on PATH here — it need not be your system default.
       Override at your own risk: `$env:MINICORE_SKIP_PYCHECK='1'
"@
    } elseif ($py.Tried -gt 0) {
      throw @"
Python appears to be on PATH, but none of the interpreters found actually ran.
       This is almost always the Microsoft Store stub: 'python' and 'python3'
       exist under %LOCALAPPDATA%\Microsoft\WindowsApps even with no real Python
       installed, and only open the Store.
       Install Python 3.11 from https://python.org (check "Add to PATH"), or turn
       the stubs off under Settings > Apps > Advanced app settings >
       App execution aliases, then re-run.
"@
    } else {
      throw 'Python not found. Install Python 3.11 (https://python.org, check "Add to PATH") and re-run.'
    }
  }
  Info "Using Python $($chosen.Version) ($($chosen.Label))"

  # ESP-IDF's install.bat runs bare `python.exe` from PATH rather than the
  # interpreter chosen above, so put the chosen one's directory first. Without
  # this, selecting `py -3.11` here would still hand ESP-IDF whichever too-new
  # (or stubbed) Python happens to own the `python` name.
  if ($chosen.Home -and (Test-Path $chosen.Home)) {
    $env:PATH = "$($chosen.Home);$env:PATH"
  }

  if (-not (Have cmake)) {
    Warn 'cmake not found — required by ESP-IDF. Install with:  winget install Kitware.CMake'
  }

  if (Test-Path (Join-Path $IdfDir '.git')) {
    # -Quiet: a shallow clone often has no tags, so `describe` failing here is
    # expected and must not surface as an error (or abort the script).
    $current = Invoke-Tool git @('-C', $IdfDir, 'describe', '--tags') -Quiet
    if ($LASTEXITCODE -ne 0 -or -not $current) { $current = 'unknown' } else { $current = "$current".Trim() }
    Info "ESP-IDF already present at .esp-idf ($current)"
    if ($current -ne $IdfVersion) {
      Warn "Installed ESP-IDF is $current, project expects $IdfVersion."
      Warn 'Delete .esp-idf and re-run to switch versions.'
    }
  } else {
    Info "Cloning ESP-IDF $IdfVersion into .esp-idf (shallow; ~a few hundred MB)"
    # --shallow-submodules: depth-1 for every submodule, not just the main repo,
    #   avoiding full submodule history. -j 8: parallel submodule fetch.
    Invoke-Tool git @(
      'clone', '--branch', $IdfVersion, '--depth', '1',
      '--recurse-submodules', '--shallow-submodules', '-j', '8',
      'https://github.com/espressif/esp-idf.git', $IdfDir
    )
    if ($LASTEXITCODE -ne 0) { throw 'ESP-IDF clone failed.' }
  }

  Info 'Installing ESP-IDF tools for esp32s3 (compiler, openocd, etc.)'
  Invoke-Tool (Join-Path $IdfDir 'install.bat') @('esp32s3')
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
  Invoke-Tool idf.py @('set-target', 'esp32s3')   # no-op once configured; ensures fresh clones build
  if ($LASTEXITCODE -ne 0) { throw "idf.py set-target failed (exit $LASTEXITCODE)." }
  Invoke-Tool idf.py @('build')
  if ($LASTEXITCODE -ne 0) { throw "idf.py build failed (exit $LASTEXITCODE)." }

  if ($BuildOnly) { return }

  $targets = @()
  if ($Port) { $targets += @('-p', $Port) }
  $targets += 'flash'
  if ($Monitor) { $targets += 'monitor' }
  Invoke-Tool idf.py $targets
  if ($LASTEXITCODE -ne 0) {
    throw "idf.py $($targets -join ' ') failed (exit $LASTEXITCODE). " +
          "If flashing failed, put the board in USB download mode: hold BOOT, press+release RESET, release BOOT, then re-run."
  }
}
finally {
  Pop-Location
}

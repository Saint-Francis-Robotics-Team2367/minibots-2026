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
  v5.3.2 into .\.esp-idf (repo-local, git-ignored) and runs its installer - no
  separate setup step. Later runs just source that SDK and are fast. To use a
  system ESP-IDF instead, set $env:IDF_PATH before running.

  If no ESP-IDF-supported Python (3.9-3.12) is found, this also downloads and
  installs Python 3.11 for your user account - no administrator rights, checksum
  verified, and it only touches your persistent PATH when you had no working
  Python at all. Set $env:MINICORE_NO_PYINSTALL='1' to be told what to install
  instead of having it done for you.

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

# Pinned interpreter installed automatically when the machine has no supported
# one. amd64 on purpose, including on ARM64 Windows: the x64 build runs under
# emulation there and has full wheel coverage, while the native ARM64 build is
# still marked experimental by python.org and lacks wheels ESP-IDF wants.
# The SHA256 was computed from the download and cross-checked against the MD5
# published on https://www.python.org/downloads/release/python-3119/
$PyInstallVersion = '3.11.9'
$PyInstallUrl     = "https://www.python.org/ftp/python/$PyInstallVersion/python-$PyInstallVersion-amd64.exe"
$PyInstallSha256  = '5ee42c4eee1e6b4464bb23722f90b45303f79442df63083f05322f1785f5fdde'

# Run one candidate interpreter and describe it, or return $null if it doesn't
# run or doesn't answer like a Python. Shared by discovery and post-install
# verification so both judge an interpreter by the same evidence: its output.
function Probe-Python($exe, $pre) {
  # Normalise to a real array: an omitted or $null $pre must become @(), not
  # @($null), which would hand python.exe a stray empty argument.
  $preArgs = @(@($pre) | Where-Object { $_ })
  $probe = 'import sys; print("%d.%d" % sys.version_info[:2]); print(sys.executable)'
  # -Quiet: a Store stub or a missing `py -3.x` writes to stderr, which is an
  # expected outcome of probing and must not surface as an error.
  $out = Invoke-Tool $exe ($preArgs + @('-c', $probe)) -Quiet
  if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
  # Output may arrive as an array of lines or one embedded-newline string;
  # normalise both, and Trim() takes care of any trailing CR.
  $lines = @(@($out) | ForEach-Object { "$_" -split "`n" } |
             ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($lines.Count -lt 2 -or $lines[0] -notmatch '^\d+\.\d+$') { return $null }
  return [pscustomobject]@{
    Exe     = $exe
    Pre     = $preArgs
    Version = $lines[0]
    Home    = Split-Path -Parent $lines[1]
    Label   = (@($exe) + $preArgs) -join ' '
  }
}

function Test-PySupported($info) {
  if (-not $info) { return $false }
  $parts = $info.Version.Split('.')
  return ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge $PyMinorMin -and [int]$parts[1] -le $PyMinorMax)
}

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
    $info = Probe-Python $c.Exe $c.Pre
    if (-not $info) { continue }
    if (-not $result.Working) { $result.Working = $info }
    if (Test-PySupported $info) { $result.Supported = $info; break }
  }
  return $result
}

# Download and install the pinned Python for the current user, and return its
# Probe-Python description (or $null if anything went wrong -- callers fall back
# to manual instructions, so every failure here warns rather than throws).
#
# Per-user by design: it needs no administrator rights, so it can't stall behind
# a UAC prompt the user may not be able to answer, and it's removable from
# Settings > Apps like any other app.
function Install-Python {
  param(
    # Add the new interpreter to the user's persistent PATH. Only safe when
    # nothing else already owns the 'python' name -- see the caller.
    [switch]$PrependUserPath
  )

  # Windows PowerShell 5.1 still negotiates TLS 1.0 by default on some machines,
  # and python.org refuses that, so the download fails with a vague "could not
  # create SSL/TLS secure channel". Opt this process into TLS 1.2 first.
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  $exeFile = Join-Path ([IO.Path]::GetTempPath()) "python-$PyInstallVersion-amd64.exe"
  Info "No supported Python found - downloading Python $PyInstallVersion (~25 MB) from python.org"
  try {
    $ProgressPreference = 'SilentlyContinue'   # faster, quieter download
    Invoke-WebRequest -Uri $PyInstallUrl -OutFile $exeFile -UseBasicParsing
  } catch {
    Warn "Python download failed: $($_.Exception.Message)"
    return $null
  }

  # This runs an installer, so verifying the pin is a hard gate, not a nicety.
  $got = (Get-FileHash -Path $exeFile -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $PyInstallSha256) {
    Remove-Item $exeFile -Force -ErrorAction SilentlyContinue
    Warn "Python installer SHA256 mismatch (got $got, expected $PyInstallSha256) - refusing to run it."
    return $null
  }

  $prependFlag = if ($PrependUserPath) { '1' } else { '0' }

  # Include_launcher registers the `py` launcher, which is what lets Find-Python
  # reach this interpreter on every later run (as `py -3.11`) even when PATH
  # never mentions it. Shortcuts/test suite/file associations are all off: this
  # is a build dependency, not an interpreter the user asked to live with.
  $instArgs = @(
    '/quiet', 'InstallAllUsers=0', 'Include_launcher=1', 'Include_pip=1',
    'Include_test=0', 'Include_doc=0', 'AssociateFiles=0', 'Shortcuts=0',
    "PrependPath=$prependFlag"
  )
  Info 'Installing it for your user account (no administrator rights needed; takes a minute)'
  # Start-Process -Wait rather than Invoke-Tool: this is a bootstrapper, and we
  # need it to have finished -- and to hand back a real exit code -- before
  # looking for python.exe on disk.
  $code = 1
  try {
    $code = (Start-Process -FilePath $exeFile -ArgumentList $instArgs -Wait -PassThru).ExitCode
  } catch {
    Warn "Could not run the Python installer: $($_.Exception.Message)"
    return $null
  } finally {
    Remove-Item $exeFile -Force -ErrorAction SilentlyContinue
  }
  if ($code -eq 3010) {
    Warn 'Python installed but Windows wants a reboot (3010); continuing anyway.'
  } elseif ($code -ne 0) {
    # 1602 = cancelled, 1618 = another install in progress.
    Warn "Python installer exited with code $code (1602 = cancelled, 1618 = another install already running)."
    return $null
  }

  # A per-user install lands in a predictable place, and PATH edits made by the
  # installer only reach *new* processes -- so locate python.exe directly rather
  # than hoping this session can see it.
  $minor = $PyInstallVersion.Split('.')[1]
  $exe   = Join-Path $env:LOCALAPPDATA "Programs\Python\Python3$minor\python.exe"
  if (-not (Test-Path $exe)) {
    Warn "Python $PyInstallVersion reported success but $exe is missing."
    return $null
  }
  $info = Probe-Python $exe @()
  if (-not (Test-PySupported $info)) {
    Warn "Installed Python at $exe did not verify as 3.$PyMinorMin-3.$PyMinorMax."
    return $null
  }

  if ($PrependUserPath) {
    Info "Installed Python $($info.Version) and added it to your PATH."
  } else {
    # Deliberately left the persistent PATH alone: another Python already owns
    # the 'python' name on this machine, and silently repointing it could break
    # the user's unrelated projects. The `py` launcher plus the process-PATH
    # prepend in Ensure-Idf cover this build without that side effect.
    Info "Installed Python $($info.Version) at $exe."
    Warn "Left your PATH as it was, since another Python already owns 'python' - reach this one with 'py -3.$minor'."
  }
  return $info
}

# --- ensure the repo-local ESP-IDF exists (first-run setup, then a no-op) ---
function Ensure-Idf {
  if (-not (Have git)) { throw 'git not found. Install Git for Windows (https://git-scm.com) and re-run.' }

  $py = Find-Python
  $chosen = $py.Supported

  # Nothing usable on this machine? Install the pinned Python instead of sending
  # the user off to do it by hand. This script already bootstraps a whole
  # ESP-IDF SDK into .esp-idf on first run, so fetching its one prerequisite is
  # in keeping -- the difference is that Python can't be repo-local (ESP-IDF's
  # installer wants a real interpreter, and per-user is the smallest footprint
  # that gives one).
  if (-not $chosen -and $env:MINICORE_NO_PYINSTALL -ne '1') {
    # Take over the persistent PATH only when no working Python exists at all.
    # If one does, it owns the 'python' name for a reason -- other projects may
    # depend on it -- and this build doesn't need to win that argument.
    $chosen = Install-Python -PrependUserPath:(-not $py.Working)
  }

  if (-not $chosen) {
    $manual = @"
Install Python 3.11 from https://python.org (check "Add to PATH"), then re-run.
       ESP-IDF installs its own venv, so 3.11 only needs to be reachable here - it
       need not become your system default.
"@
    if ($env:MINICORE_SKIP_PYCHECK -eq '1' -and $py.Working) {
      $chosen = $py.Working
      Warn "Skipping Python version check (MINICORE_SKIP_PYCHECK=1); using $($chosen.Version) ($($chosen.Label))."
    } elseif ($py.Working) {
      throw @"
Python $($py.Working.Version) ($($py.Working.Label)) is not supported by ESP-IDF v$($IdfVersion.TrimStart('v')),
       and installing a supported one automatically didn't work (see above).
       Use Python 3.$PyMinorMin-3.$PyMinorMax (3.11 recommended). $manual
       Override at your own risk: `$env:MINICORE_SKIP_PYCHECK='1'
"@
    } elseif ($py.Tried -gt 0) {
      throw @"
No working Python, and installing one automatically didn't work (see above).
       The interpreters on PATH are almost certainly Microsoft Store stubs:
       'python' and 'python3' exist under %LOCALAPPDATA%\Microsoft\WindowsApps
       even with no real Python installed, and only open the Store.
       $manual
       You can also turn the stubs off under Settings > Apps > Advanced app
       settings > App execution aliases.
"@
    } else {
      throw "Python not found, and installing it automatically didn't work (see above).`n       $manual"
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
    Warn 'cmake not found - required by ESP-IDF. Install with:  winget install Kitware.CMake'
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

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

  If no working Python is found at all, it also downloads and installs Python
  3.11 for your user account (no administrator rights, checksum verified) and
  adds it to your PATH. Set $env:MINICORE_NO_PYINSTALL='1' to be told what to
  install instead of having it done for you.

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

function Info($m) { Write-Host "[info] $m" }
function Warn($m) { Write-Host "[warn] $m" -ForegroundColor Yellow }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Run an external tool (python/pip/esptool/mpremote) and let the CALLER decide
# what a failure means, by checking $LASTEXITCODE afterwards.
#
# This wrapper exists because $ErrorActionPreference = 'Stop' above -- which we
# want for cmdlets -- also hijacks native commands:
#   * Windows PowerShell 5.1 turns *any* write to stderr into an error record,
#     so it aborts the script the moment a tool prints a traceback, a pip
#     warning, or an mpremote diagnostic -- before we can inspect the exit code.
#   * PowerShell 7.3+ does the same for any non-zero exit code, via
#     $PSNativeCommandUseErrorActionPreference.
# Both defeat the "probe, then recover" logic below: a failed import probe would
# kill the run instead of triggering the install it exists to trigger.
#
# The tool is launched here rather than via a caller-supplied scriptblock on
# purpose -- a scriptblock runs in a child scope of where it was *defined*, so
# it would never see these function-scoped preferences. Scoping them to this
# function keeps 'Stop' semantics everywhere else in the script.
function Invoke-Tool {
  param(
    [Parameter(Mandatory, Position = 0)][string]$Exe,
    [Parameter(Position = 1)][string[]]$Arguments = @(),
    [switch]$Quiet   # discard stdout+stderr (probes and noisy no-ops)
  )
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  # Seed a failure code so a tool that can't even launch reads as "failed"
  # rather than inheriting the previous command's success.
  $global:LASTEXITCODE = 1
  if ($Quiet) { & $Exe @Arguments *> $null } else { & $Exe @Arguments }
}

# Pinned interpreter installed automatically when the machine has no working
# Python at all. Keep in sync with scripts\flash-dongle.ps1 -- the version is
# chosen there, to satisfy ESP-IDF v5.3.2's supported 3.9-3.12 range; this script
# only needs "some Python 3" and shares the pin so one machine ends up with one
# interpreter. amd64 on purpose, including on ARM64 Windows: it runs under
# emulation there and has full wheel coverage, while the native ARM64 build is
# still experimental. The SHA256 was computed from the download and
# cross-checked against the MD5 published on python.org.
$PyInstallVersion = '3.11.9'
$PyInstallUrl     = "https://www.python.org/ftp/python/$PyInstallVersion/python-$PyInstallVersion-amd64.exe"
$PyInstallSha256  = '5ee42c4eee1e6b4464bb23722f90b45303f79442df63083f05322f1785f5fdde'

# Download and install the pinned Python for the current user; return the path to
# its python.exe, or $null if anything went wrong (the caller falls back to
# manual instructions, so every failure here warns rather than throws).
#
# Per-user by design: no administrator rights, so it can't stall behind a UAC
# prompt a student may not be able to answer, and it uninstalls from Settings >
# Apps like any other app. PrependPath=1 is safe here because this only runs when
# no working Python was found, so nothing else owns the 'python' name.
function Install-Python {
  # Windows PowerShell 5.1 still negotiates TLS 1.0 by default on some machines
  # and python.org refuses that, failing with a vague "could not create SSL/TLS
  # secure channel". Opt this process into TLS 1.2 first.
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  $exeFile = Join-Path ([IO.Path]::GetTempPath()) "python-$PyInstallVersion-amd64.exe"
  Info "No Python found - downloading Python $PyInstallVersion (~25 MB) from python.org"
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

  # Include_launcher registers `py`, so later runs can find this interpreter even
  # if PATH changes. Shortcuts/docs/test suite/file associations stay off: this is
  # a build dependency, not an interpreter the user asked to live with.
  $instArgs = @(
    '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1',
    'Include_pip=1', 'Include_test=0', 'Include_doc=0', 'AssociateFiles=0',
    'Shortcuts=0'
  )
  Info 'Installing it for your user account (no administrator rights needed; takes a minute)'
  # Start-Process -Wait rather than Invoke-Tool: this is a bootstrapper, and it
  # must have finished -- and returned a real exit code -- before we look for
  # python.exe on disk.
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

  # PrependPath only reaches *new* processes, so this session still can't see the
  # new interpreter by name. A per-user install lands in a predictable place --
  # use the full path, and confirm it actually runs before trusting it.
  $minor = $PyInstallVersion.Split('.')[1]
  $exe   = Join-Path $env:LOCALAPPDATA "Programs\Python\Python3$minor\python.exe"
  if (-not (Test-Path $exe)) {
    Warn "Python $PyInstallVersion reported success but $exe is missing."
    return $null
  }
  Invoke-Tool $exe @('-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)') -Quiet
  if ($LASTEXITCODE -ne 0) {
    Warn "Installed Python at $exe did not run as Python 3."
    return $null
  }
  Info "Installed Python $PyInstallVersion and added it to your PATH."
  return $exe
}

# The venv's python (Windows puts it under Scripts\). Everything runs through
# this as `python -m ...`, so no console-script shim or PATH entry is needed.
$PyBin = Join-Path $VenvDir 'Scripts\python.exe'

# True if the venv python can already import both tools.
function Tools-Ready {
  if (-not (Test-Path $PyBin)) { return $false }
  Invoke-Tool $PyBin @('-c', 'import esptool, mpremote') -Quiet
  return ($LASTEXITCODE -eq 0)
}

# --- ensure flash tools (esptool + mpremote) -- first-run setup, then a no-op ---
function Ensure-Tools {
  if (Tools-Ready) { return }

  # Pick a Python that actually RUNS, not merely one whose name resolves.
  # Get-Command finds Windows' App Execution Alias stubs for 'python' and
  # 'python3' (under %LOCALAPPDATA%\Microsoft\WindowsApps) on every machine even
  # with no Python installed; they just open the Microsoft Store. Committing to
  # the first name found would fail later with a confusing error, so probe each.
  $Python = $null
  $tried = 0
  foreach ($c in 'py', 'python', 'python3') {
    if (-not (Have $c)) { continue }
    $tried++
    # -Quiet: a Store stub writes to stderr, which is an expected probe outcome.
    Invoke-Tool $c @('-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)') -Quiet
    if ($LASTEXITCODE -eq 0) { $Python = $c; break }
  }
  # No working interpreter? Install the pinned one rather than sending the user
  # off to do it by hand. This script already bootstraps its own tools into
  # .venv-flash on first run, so fetching the one prerequisite it can't put there
  # is in keeping.
  if (-not $Python -and $env:MINICORE_NO_PYINSTALL -ne '1') {
    $Python = Install-Python
  }

  if (-not $Python) {
    if ($tried -gt 0) {
      throw @"
No working Python, and installing one automatically didn't work (see above).
       The interpreters on PATH are almost certainly Microsoft Store stubs:
       'python' and 'python3' exist under %LOCALAPPDATA%\Microsoft\WindowsApps
       even with no real Python installed, and only open the Store.
       Install Python 3 from https://python.org (check "Add to PATH"), or turn the
       stubs off under Settings > Apps > Advanced app settings >
       App execution aliases, then re-run.
"@
    }
    throw @"
Python not found, and installing it automatically didn't work (see above).
       Install Python 3 from https://python.org (check "Add to PATH") and re-run
       (it's needed to install esptool + mpremote).
"@
  }

  # A venv directory can exist without a working python inside it (an
  # interrupted or failed first run). Clear it out so `venv` builds a clean one
  # instead of erroring on the half-made tree.
  if ((Test-Path $VenvDir) -and -not (Test-Path $PyBin)) {
    Write-Host "[info] Removing incomplete tool virtualenv at $VenvDir"
    Remove-Item -Recurse -Force $VenvDir -ErrorAction SilentlyContinue
  }

  if (-not (Test-Path $PyBin)) {
    Write-Host "[info] Creating tool virtualenv at $VenvDir (one time)"
    Invoke-Tool $Python @('-m', 'venv', $VenvDir)
    if ($LASTEXITCODE -ne 0) { throw "Failed to create virtualenv at $VenvDir with '$Python -m venv'." }
    if (-not (Test-Path $PyBin)) { throw "Virtualenv created at $VenvDir but $PyBin is missing. Delete $VenvDir and re-run." }
  }

  Write-Host '[info] Installing esptool + mpremote (one time)'
  Invoke-Tool $PyBin @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip') -Quiet
  Invoke-Tool $PyBin @('-m', 'pip', 'install', '--upgrade', 'esptool', 'mpremote')
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
  Invoke-Tool $PyBin ($MpremoteArgs + $MprDev + 'repl')
  exit $LASTEXITCODE
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
  Invoke-Tool $PyBin ($EsptoolArgs + @('--chip', 'esp32') + $portArgs + 'erase_flash')
  if ($LASTEXITCODE -ne 0) { throw "esptool erase_flash failed (exit $LASTEXITCODE). Put the board in download mode (hold BOOT, tap RESET, release BOOT) and re-run." }
  Invoke-Tool $PyBin ($EsptoolArgs + @('--chip', 'esp32') + $portArgs + @('write_flash', '-z', '0x1000', $Bin.FullName))
  if ($LASTEXITCODE -ne 0) { throw "esptool write_flash failed (exit $LASTEXITCODE)." }
  Write-Host "[info] MicroPython installed. Now run .\scripts\flash-robot.ps1 to upload your code."
  exit 0
}

# Default: upload student code and reboot into it.
#
# Opening the serial port resets the ESP32, so mpremote's Ctrl-C to break into
# the REPL races against the robot's boot + Wi-Fi/ESP-NOW init (during which
# Python can't be interrupted). When it loses that race you get
# "could not enter raw repl". Retrying re-runs the race and one attempt lands
# while the board is interruptible, so a small bounded retry loop is reliable.
Write-Host "[info] Uploading main.py + minibot.py + minibot_config.py + display.py + ssd1306.py"
$UploadTries = 5
$uploaded = $false
for ($try = 1; $try -le $UploadTries; $try++) {
  Invoke-Tool $PyBin ($MpremoteArgs + $MprDev + @('fs', 'cp', (Join-Path $Proj 'minibot.py'), (Join-Path $Proj 'minibot_config.py'), (Join-Path $Proj 'display.py'), (Join-Path $Proj 'ssd1306.py'), (Join-Path $Proj 'main.py'), ':'))
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

Invoke-Tool $PyBin ($MpremoteArgs + $MprDev + 'reset')
if ($LASTEXITCODE -ne 0) { Write-Host "[warn] Upload succeeded but the reset didn't (exit $LASTEXITCODE). Power-cycle the board to run your code." -ForegroundColor Yellow }
Write-Host "[info] Uploaded and reset. Use -Repl to watch output."
exit 0

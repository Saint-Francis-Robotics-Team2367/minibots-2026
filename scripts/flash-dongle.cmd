@echo off
REM Double-clickable launcher for flash-dongle.ps1 that bypasses PowerShell's
REM execution policy. Pass flags through, e.g.:
REM   flash-dongle.cmd -Port COM7
REM   flash-dongle.cmd -Monitor
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash-dongle.ps1" %*
set "RC=%ERRORLEVEL%"

REM Safety net: if the script failed for ANY reason -- including a PowerShell
REM parse error, which the .ps1's own error trap cannot catch -- keep this
REM window open so the message is readable instead of flashing and vanishing.
if not "%RC%"=="0" (
  echo.
  echo [flash-dongle exited with code %RC%]
  pause
)
exit /b %RC%

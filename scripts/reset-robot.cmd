@echo off
REM Double-clickable launcher for reset-robot.ps1 (complete firmware reset)
REM that bypasses PowerShell's execution policy. Pass flags through, e.g.:
REM   reset-robot.cmd -Port COM5
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reset-robot.ps1" %*
set "RC=%ERRORLEVEL%"

REM Safety net: if the script failed for ANY reason -- including a PowerShell
REM parse error, which the .ps1's own error trap cannot catch -- keep this
REM window open so the message is readable instead of flashing and vanishing.
if not "%RC%"=="0" (
  echo.
  echo [reset-robot exited with code %RC%]
  pause
)
exit /b %RC%

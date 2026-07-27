@echo off
REM Double-clickable launcher for flash-robot.ps1 that bypasses PowerShell's
REM execution policy. Pass flags through, e.g.:
REM   flash-robot.cmd -Firmware
REM   flash-robot.cmd -Port COM5
REM   flash-robot.cmd -Repl
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash-robot.ps1" %*
set "RC=%ERRORLEVEL%"

REM Safety net: if the script failed for ANY reason -- including a PowerShell
REM parse error, which the .ps1's own error trap cannot catch -- keep this
REM window open so the message is readable instead of flashing and vanishing.
if not "%RC%"=="0" (
  echo.
  echo [flash-robot exited with code %RC%]
  pause
)
exit /b %RC%

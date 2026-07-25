@echo off
REM Double-clickable launcher for flash-dongle.ps1 that bypasses PowerShell's
REM execution policy. Pass flags through, e.g.:
REM   flash-dongle.cmd -Port COM7
REM   flash-dongle.cmd -Monitor
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash-dongle.ps1" %*

@echo off
REM Double-clickable launcher for flash-robot.ps1 that bypasses PowerShell's
REM execution policy. Pass flags through, e.g.:
REM   flash-robot.cmd -Firmware
REM   flash-robot.cmd -Port COM5
REM   flash-robot.cmd -Repl
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash-robot.ps1" %*

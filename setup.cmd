@echo off
REM Double-clickable launcher for setup.ps1 that bypasses PowerShell's
REM execution policy (about_Execution_Policies) without changing machine
REM settings. Batch files are not subject to the execution policy.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*

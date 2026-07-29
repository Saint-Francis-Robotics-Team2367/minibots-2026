@echo off
REM Double-clickable launcher for flash-robot.ps1 that bypasses PowerShell's
REM execution policy. Pass flags through, e.g.:
REM   flash-robot.cmd -Firmware
REM   flash-robot.cmd -Port COM5
REM   flash-robot.cmd -Repl
setlocal
set "PS1=%~dp0flash-robot.ps1"

REM Running this straight out of a .zip is the common way to get here: Explorer
REM copies the double-clicked .cmd alone into a Temp folder, so its sibling .ps1
REM isn't next to it. PowerShell's own -File error doesn't say which path was
REM missing, so name it and lead with the likely cause.
if not exist "%PS1%" (
  echo.
  echo [error] Can't find flash-robot.ps1 next to this launcher:
  echo         %PS1%
  echo.
  echo Did you extract the ZIP? Running these scripts from inside the ZIP
  echo doesn't work. Right-click the .zip -^> "Extract All...", then run
  echo scripts\flash-robot.cmd from the extracted folder.
  echo.
  pause
  exit /b 9009
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
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

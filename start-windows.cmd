@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\quickstart.ps1" -Desktop -Pull
set "result=%ERRORLEVEL%"
echo.
pause
exit /b %result%

@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "workdeskExitCode=%errorlevel%"
if not "%workdeskExitCode%"=="0" pause
exit /b %workdeskExitCode%

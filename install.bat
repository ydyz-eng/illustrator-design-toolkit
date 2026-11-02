@echo off
setlocal DisableDelayedExpansion
title AI Design Toolbox Installer
set "AI_TOOLBOX_SOURCE=%~dp0"
set "AI_TOOLBOX_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%AI_TOOLBOX_POWERSHELL%" goto run
echo [ERROR] Windows PowerShell is unavailable on this computer.
echo Press any key to close this window.
pause >nul
exit /b 1
:run
if exist "%~dp0scripts\install.ps1" goto install
echo [ERROR] Installer files are missing. Extract the entire ZIP first.
echo Press any key to close this window.
pause >nul
exit /b 1
:install
"%AI_TOOLBOX_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { & ([System.Management.Automation.WildcardPattern]::Escape([IO.Path]::Combine($env:AI_TOOLBOX_SOURCE, 'scripts\install.ps1'))); exit $LASTEXITCODE } catch { Write-Host $_ -ForegroundColor Red; exit 1 }"
set "AI_TOOLBOX_RESULT=%errorlevel%"
echo.
echo Press any key to close this window.
pause >nul
exit /b %AI_TOOLBOX_RESULT%

@echo off
chcp 65001 >nul 2>nul
set ELECTRON_RUN_AS_NODE=
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set WIN_CSC_KEY_PASSWORD=

cd /d "%~dp0"
echo [MC DevKit] Build starting...
echo.

where node 1>nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    pause
    exit /b 1
)

echo Cleaning build cache...
rd /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" 2>nul

echo [1/2] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
)

echo.
if exist "resources\jre\bin\java.exe" (
    echo [2/2] Building installer with bundled Java + Paper...
    call npx electron-builder --win --config electron-builder.bundle.json
) else (
    echo [2/2] Building installer...
    call npm run build:win
)

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build failed.
    echo.
    echo If you see a "symbolic link" error, choose one of:
    echo   1. Enable Developer Mode: Settings - System - For developers - ON
    echo   2. Right-click this file and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo.
echo [DONE] Setup file is in dist\ folder.
echo.
pause

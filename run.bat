@echo off
title GTA 6 News Automation - gtavistore.ir
echo ========================================================
echo   Running GTA VI News Automation for gtavistore.ir ...
echo ========================================================

set "NODE_CMD=node"

where node >nul 2>nul
if %errorlevel% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    ) else if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_CMD=%ProgramFiles%\nodejs\node.exe"
    ) else (
        echo [ERROR] Node.js not found!
        echo Please ensure Node.js is installed.
        pause
        exit /b 1
    )
)

"%NODE_CMD%" "%~dp0fetch_and_publish.js"

echo.
echo ========================================================
echo Done! Check latest article at:
echo %~dp0drafts\latest_article.html
echo ========================================================
pause

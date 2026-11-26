@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
    echo Node.js 18 or later is required.
    exit /b 1
)
node "%~dp0server.mjs" %*
exit /b %errorlevel%

@echo off
setlocal
cd /d %~dp0
title AideR - First Install

echo.
echo  ============================================
echo    AideR - First Install
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js not found. Install LTS from https://nodejs.org
  echo  Then run this file again. Also install R from https://cran.r-project.org
  echo  and set up a local model (LM Studio or Ollama) for AI.
  pause
  goto :eof
)

echo  [1/2] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo  [ERROR] npm install failed. Check network and retry.
  pause
  goto :eof
)

echo  [2/2] Building frontend...
call npm run build
if errorlevel 1 (
  echo  [ERROR] Frontend build failed.
  pause
  goto :eof
)

echo.
echo  ============================================
echo    Install complete!
echo    Now double-click LaunchAssistant.bat to start.
echo  ============================================
echo.
pause

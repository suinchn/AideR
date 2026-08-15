@echo off
setlocal
cd /d %~dp0
title AideR

echo.
echo  ============================================
echo    AideR - starting
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto node_err

if not exist "node_modules\vite\package.json" (
  echo  [INFO] Installing dependencies first time...
  echo.
  call npm install
  if errorlevel 1 goto install_err
)

set "RSC=C:\Program Files\R\R-4.6.1\bin\Rscript.exe"
if exist "%RSC%" (
  echo  [OK] Rscript found
) else (
  echo  [NOTE] Rscript not in default path. Set it under Settings.
)

if not exist "client\dist\index.html" (
  echo  [INFO] Building frontend...
  call npm run build
  if errorlevel 1 goto build_err
)

echo.
echo  [INFO] Starting server at http://127.0.0.1:8787 ...
start "" /min cmd /k "cd /d %~dp0 && node server\index.js"

echo  [INFO] Opening browser...
set URL=http://127.0.0.1:8787
set WAITED=0
:wait
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',8787);exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto opened
set /a WAITED+=1
if %WAITED% GEQ 60 goto noport
timeout /t 1 /nobreak >nul
goto wait

:opened
echo  [OK] Browser opened. Server runs in the small window (logs).
echo  To STOP: close that small console window.
echo  To reopen later: double-click this file again.
echo.
pause
goto :eof

:node_err
echo  [ERROR] Node.js not found. Install from https://nodejs.org
pause
goto :eof

:install_err
echo  [ERROR] npm install failed. Run FirstInstall.bat or check network.
pause
goto :eof

:build_err
echo  [ERROR] Frontend build failed.
pause
goto :eof

:noport
echo  [WARN] Server did not start in 60s. Check the small console window.
pause
goto :eof

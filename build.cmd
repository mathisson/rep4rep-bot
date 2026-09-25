@echo off
setlocal
cd /d "%~dp0"

echo.
echo  Rep4Rep - building the desktop app
echo  ----------------------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js is not installed, or not on PATH.
  echo  Get it from https://nodejs.org and run this again.
  goto :fail
)

echo  [1/2] Installing dependencies...
call npm install --no-fund --no-audit
if errorlevel 1 goto :fail

echo  [2/2] Packaging...
call npm run build
if errorlevel 1 goto :fail

echo.
echo  Done. Your app is here:
echo.
echo      %CD%\dist\Rep4Rep-win32-x64\Rep4Rep.exe
echo.
echo  Double-click it. It asks for your rep4rep API token and Steam
echo  sign-in the first time, then remembers both.
echo.
pause
exit /b 0

:fail
echo.
echo  Build failed. Scroll up for the error.
echo.
pause
exit /b 1

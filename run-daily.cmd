@echo off
rem What the scheduled task actually runs. Headless: no prompts, output to a log.
setlocal
cd /d "%~dp0"

set "LOG=%USERPROFILE%\.rep4rep-cli\daily.log"
if not exist "%USERPROFILE%\.rep4rep-cli" mkdir "%USERPROFILE%\.rep4rep-cli"

>>"%LOG%" echo.
>>"%LOG%" echo ===== %date% %time% =====

rem -y skips the confirmation prompt, since nothing is there to answer it.
node src\cli.js run -y >>"%LOG%" 2>&1

exit /b %errorlevel%

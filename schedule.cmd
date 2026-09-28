@echo off
rem Sets up (or removes) a daily Windows task that runs the comment batch.
setlocal
cd /d "%~dp0"

set "TASK=Rep4Rep daily run"
set "LOG=%USERPROFILE%\.rep4rep-cli\daily.log"

if /i "%~1"=="/remove" goto remove
if /i "%~1"=="/status" goto status
if /i "%~1"=="/log"    goto showlog
if /i "%~1"=="/?"      goto usage

set "AT=%~1"
if "%AT%"=="" set "AT=09:00"

echo.
echo  Scheduling a daily run at %AT%
echo.

schtasks /Create /TN "%TASK%" /TR "\"%CD%\run-daily.cmd\"" /SC DAILY /ST %AT% /F >nul
if errorlevel 1 (
  echo  Could not create the task. Scroll up for the error.
  goto done
)

echo  Done. It will run every day at %AT%, whether or not the app is open.
echo.
echo    Output      %LOG%
echo    Change time schedule.cmd 21:30
echo    Check       schedule.cmd /status
echo    Remove      schedule.cmd /remove
echo.
echo  Sign-ins and your API token are already saved, so it needs nothing further.
goto done

:status
schtasks /Query /TN "%TASK%" /V /FO LIST 2>nul | findstr /i "TaskName Next Last Status"
if errorlevel 1 echo  No daily task is set up. Run schedule.cmd to create one.
goto done

:showlog
if exist "%LOG%" ( type "%LOG%" ) else ( echo  Nothing logged yet. )
goto done

:remove
schtasks /Delete /TN "%TASK%" /F >nul 2>&1
if errorlevel 1 ( echo  No daily task was set up. ) else ( echo  Daily run removed. )
goto done

:usage
echo  schedule.cmd [HH:MM]   create or move the daily run    (default 09:00)
echo  schedule.cmd /status   show when it next runs
echo  schedule.cmd /log      show what it did
echo  schedule.cmd /remove   delete it

:done
echo.
pause

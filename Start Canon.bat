@echo off
rem Strategi Canon starter (Windows). Double-click me.
cd /d %~dp0
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 launcher.py %*
) else (
    python launcher.py %*
)
echo.
echo [canon] Strategi Canon has stopped. Read any errors above.
pause

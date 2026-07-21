@echo off
rem Strategi Canon setup (Windows). Double-click me ONCE, before the first launch.
rem
rem If SmartScreen shows "Windows protected your PC", click More info, then Run
rem anyway. Once only, same as the app itself. That warning comes from the file
rem arriving in a download, not from anything it does.
cd /d "%~dp0"

rem Prefer the Python bundled inside the app, so setup needs nothing installed.
set "APP_PY=Strategi Canon\runtimes\python\python.exe"
if exist "%APP_PY%" (
    "%APP_PY%" canon_setup.py
    goto done
)

rem Fall back to a system Python only if the app has not unpacked its runtime yet.
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 canon_setup.py
    goto done
)
where python >nul 2>nul
if %errorlevel%==0 (
    python canon_setup.py
    goto done
)

echo No Python found to run setup.
echo Open "Strategi Canon" once so it unpacks its bundled Python, then run this again.

:done
echo.
pause

@echo off
rem Build "Strategi Canon.exe" (Windows) into canon_app\dist\.
rem
rem Uses a THROWAWAY build venv (canon_app\.buildvenv, gitignored) so the
rem packaging toolchain never touches the engine's .venv or its requirements.
rem
rem Onedir, not onefile, deliberately: a onefile exe self-extracts to %TEMP%
rem on EVERY launch (slow start, and the extraction pattern trips SmartScreen
rem and AV heuristics far more often), while the release artifact is a zip of
rem the dist folder either way. Coworkers double-click the .exe inside the
rem "Strategi Canon" folder, same as double-clicking a Mac .app.
setlocal
cd /d "%~dp0"

echo ==^> build venv (.buildvenv, throwaway)
if exist .buildvenv rmdir /s /q .buildvenv
python -m venv .buildvenv || py -3 -m venv .buildvenv
if errorlevel 1 exit /b 1
.buildvenv\Scripts\python -m pip install --upgrade pip
if errorlevel 1 exit /b 1
.buildvenv\Scripts\python -m pip install -r requirements.txt
if errorlevel 1 exit /b 1

echo ==^> app icons (Pillow-generated, gitignored)
.buildvenv\Scripts\python make_icons.py
if errorlevel 1 exit /b 1

echo ==^> bundled runtimes (Node + Python, ~280 MB, cached between builds)
.buildvenv\Scripts\python fetch_runtimes.py
if errorlevel 1 exit /b 1

echo ==^> PyInstaller
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist
.buildvenv\Scripts\pyinstaller ^
    --noconfirm --clean ^
    --windowed ^
    --name "Strategi Canon" ^
    --icon build_assets\canon.ico ^
    --hidden-import pystray._win32 ^
    tray.py
if errorlevel 1 exit /b 1

rem Copy the runtimes in after PyInstaller rather than via --add-data, which
rem resolves symlinks and would break Python's bin\python3 and npm's shims.
rem Windows has no code seal to invalidate, so ordering matters less here than
rem on macOS, but keeping the two builds structurally identical is worth more
rem than saving a step. xcopy /E /I /Q preserves the tree as-is.
echo ==^> embedding runtimes into the app folder
xcopy build_assets\runtimes "dist\Strategi Canon\runtimes" /E /I /Q /Y
if errorlevel 1 exit /b 1

rem Precompile the bundled stdlib for the same reason macOS does: first-run .pyc
rem writes are slow and, in a read-only install location, may fail outright.
echo ==^> precompiling bundled stdlib
"dist\Strategi Canon\runtimes\python\python.exe" -m compileall -q -j 0 "dist\Strategi Canon\runtimes\python\Lib" >nul 2>&1

echo ==^> done: canon_app\dist\Strategi Canon\Strategi Canon.exe
echo     Unsigned. SmartScreen will warn until this is signed with an
echo     Authenticode certificate. See canon_app\SIGNING.md.
endlocal

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

echo ==^> done: canon_app\dist\Strategi Canon\Strategi Canon.exe
endlocal

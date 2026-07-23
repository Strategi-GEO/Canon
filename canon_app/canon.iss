; Inno Setup script for Strategi Canon (Windows single-app installer).
;
; Turns the onedir PyInstaller output (dist\Strategi Canon\, which build-windows.bat has already
; populated with the runtimes and the embedded canon-tree) into ONE downloadable file:
; Strategi-Canon-windows-setup.exe. The operator runs it once and gets a normal installed program,
; a Start-menu entry, and, if they tick it, launch-at-login. No folder to dig through, no exe to
; hunt for. This is the Windows counterpart to the macOS single .app.
;
; PER-USER INSTALL ON PURPOSE (PrivilegesRequired=lowest): installs under the user's own
; %LOCALAPPDATA%\Programs with NO admin prompt. An admin/UAC elevation on an UNSIGNED installer is
; the scariest possible first-run, and a per-user install avoids it entirely. It also means the
; app can materialize its tree and write its data under the same user without permission games.
;
; Built in CI with:  iscc /DMyAppVersion=0.1.6 canon_app\canon.iss

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "Strategi Canon"
#define MyAppExe "Strategi Canon.exe"

[Setup]
AppId={{5C0F5B2E-4A1D-4C3B-9E7A-CA0F0N5T0R01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Strategi
DefaultDirName={autopf}\{#MyAppName}
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=.
OutputBaseFilename=Strategi-Canon-windows-setup
SetupIconFile=build_assets\canon.ico
UninstallDisplayIcon={app}\{#MyAppExe}
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
; The payload is ~300 MB of bundled runtimes, so a per-user install location and a quiet finish
; matter more than a fancy wizard. ArchitecturesInstallIn64BitMode keeps the 64-bit layout.
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
; The whole onedir app, recursively. Its own layout (the exe at the root, runtimes\ and
; canon-tree\ beside it) is exactly what tray.py's exe_dir resolution expects, so nothing is
; rearranged here.
Source: "dist\{#MyAppName}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExe}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start {#MyAppName} automatically when I log in (recommended)"; GroupDescription: "Startup:"

[Registry]
; The SAME HKCU Run value tray.py's 'Start at login' toggle writes ('StrategiCanon'), so the
; installer's opt-in and the in-app toggle are one setting the uninstaller also cleans up.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; \
    ValueName: "StrategiCanon"; ValueData: """{app}\{#MyAppExe}"""; \
    Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExe}"; Description: "Launch {#MyAppName} now"; \
    Flags: nowait postinstall skipifsilent

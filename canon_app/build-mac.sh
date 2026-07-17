#!/usr/bin/env bash
# Build "Strategi Canon.app" (macOS) into canon_app/dist/.
#
# Uses a THROWAWAY build venv (canon_app/.buildvenv, gitignored) so the
# packaging toolchain never touches the engine's .venv or its requirements.
# Override the base interpreter with PYTHON=/path/to/python3 if needed.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

echo "==> build venv (.buildvenv, throwaway)"
rm -rf .buildvenv
"$PYTHON" -m venv .buildvenv
.buildvenv/bin/python -m pip install --upgrade pip
.buildvenv/bin/python -m pip install -r requirements.txt

echo "==> app icons (Pillow-generated, gitignored)"
.buildvenv/bin/python make_icons.py

echo "==> PyInstaller"
rm -rf build dist
.buildvenv/bin/pyinstaller \
    --noconfirm --clean \
    --windowed \
    --name "Strategi Canon" \
    --icon build_assets/canon.icns \
    --osx-bundle-identifier is.strategi.canon \
    --hidden-import pystray._darwin \
    tray.py

# Menu-bar-only app: no Dock icon, no app switcher entry. PyInstaller has no
# flag for LSUIElement, so stamp it into the bundle's Info.plist after the fact.
PLIST="dist/Strategi Canon.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c 'Set :LSUIElement true' "$PLIST"

echo "==> done: canon_app/dist/Strategi Canon.app"

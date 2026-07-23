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

echo "==> bundled runtimes (Node + Python, ~280 MB, cached between builds)"
.buildvenv/bin/python fetch_runtimes.py

echo "==> PyInstaller"
rm -rf build dist
.buildvenv/bin/pyinstaller \
    --noconfirm --clean \
    --windowed \
    --name "Strategi Canon" \
    --icon build_assets/canon.icns \
    --osx-bundle-identifier is.strategi.canon \
    --hidden-import pystray._darwin \
    --hidden-import secrets_bootstrap \
    --hidden-import certifi \
    --add-data "bootstrap.json:." \
    tray.py

APP="dist/Strategi Canon.app"

# Copy the runtimes in with ditto rather than PyInstaller's --add-data, which
# resolves symlinks. Node's bin/npm is a symlink into lib/node_modules and
# Python's bin/python3 is a symlink to python3.12; flattening either produces a
# runtime that looks fine on disk and fails on first use. ditto preserves
# symlinks, permissions, and the executable bit.
echo "==> embedding runtimes into the bundle"
mkdir -p "$APP/Contents/Resources"
ditto build_assets/runtimes "$APP/Contents/Resources/runtimes"

# Precompile the bundled stdlib BEFORE signing, or the app breaks its own
# signature the first time it runs. CPython writes __pycache__/*.pyc next to any
# stdlib module it imports that lacks a fresh one. Inside a signed bundle those
# new files are unsealed additions, so codesign --verify starts reporting
# "a sealed resource is missing or invalid" after first launch, on the
# recipient's machine, with no way to explain it. Compiling now means the .pyc
# already exist and get sealed, and CPython has no reason to rewrite them.
# The engine's .venv resolves its stdlib back into this tree, so this covers the
# engine too, not just the venv-creation step.
echo "==> precompiling bundled stdlib (keeps the signature stable after first run)"
BUNDLED_PY="$APP/Contents/Resources/runtimes/python/bin/python3"
find "$APP/Contents/Resources/runtimes/python" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
# compileall exits non-zero if ANY file fails; the stdlib ships a few intentionally
# broken samples (lib2to3 test grammars), so failures here are expected and benign.
"$BUNDLED_PY" -m compileall -q -j 0 \
    "$APP/Contents/Resources/runtimes/python/lib/python3.12" >/dev/null 2>&1 || true
PYC_COUNT=$(find "$APP/Contents/Resources/runtimes/python" -name '*.pyc' | wc -l | tr -d ' ')
echo "    precompiled $PYC_COUNT .pyc files"

# SINGLE-APP MODE: embed the whole Canon source tree (server, prebuilt dashboard, launcher,
# client templates) into the bundle, beside the runtimes. CI stages the tree with git archive
# and passes CANON_TREE; a local build without it produces the classic launcher-only app that
# runs from a sibling folder. ditto for the same symlink/exec-bit reasons as the runtimes.
# BEFORE signing, so the tree is sealed with everything else. The engine never RUNS from this
# copy (tray.py materializes it to Application Support first), so nothing writes into the
# sealed bundle at runtime.
if [ -n "${CANON_TREE:-}" ]; then
    echo "==> embedding the Canon source tree (single-app mode)"
    ditto "$CANON_TREE" "$APP/Contents/Resources/canon-tree"
    test -f "$APP/Contents/Resources/canon-tree/launcher.py" \
        || { echo "canon-tree is missing launcher.py"; exit 1; }
    test -f "$APP/Contents/Resources/canon-tree/server/app.py" \
        || { echo "canon-tree is missing server/app.py"; exit 1; }
    if [ -e "$APP/Contents/Resources/canon-tree/server/.env" ]; then
        echo "REFUSING: server/.env is inside the staged tree"; exit 1
    fi
fi

# Menu-bar-only app: no Dock icon, no app switcher entry. PyInstaller has no
# flag for LSUIElement, so stamp it into the bundle's Info.plist after the fact.
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :LSUIElement bool true' "$PLIST" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c 'Set :LSUIElement true' "$PLIST"

# Editing Info.plist and copying the runtimes in both invalidate the signature
# PyInstaller applied, and macOS rejects a BROKEN signature harder than an absent
# one: the bundle reads as "damaged", which the right-click > Open workaround does
# NOT clear. So signing happens last, after every mutation of the bundle.
#
# Set CODESIGN_IDENTITY to a "Developer ID Application: ..." identity for real
# distribution. The ad-hoc default keeps the app runnable but still trips
# Gatekeeper on machines other than the one that built it.
IDENTITY="${CODESIGN_IDENTITY:--}"
echo "==> codesign (identity: ${IDENTITY})"

SIGN_ARGS=(--force --sign "$IDENTITY" --timestamp=none)
if [ "$IDENTITY" != "-" ]; then
    # Hardened runtime + secure timestamp are both required by notarization.
    SIGN_ARGS=(--force --sign "$IDENTITY" --options runtime --timestamp
               --entitlements entitlements.plist)
fi

# Sign inside-out: nested code first, bundle last. Apple deprecated --deep for
# distribution signing precisely because it applies the outer bundle's
# entitlements to nested binaries, and the notary service rejects the result.
echo "    signing nested Mach-O binaries under Resources/runtimes (and canon-tree when embedded)"
SIGN_ROOTS=("$APP/Contents/Resources/runtimes")
if [ -d "$APP/Contents/Resources/canon-tree" ]; then
    SIGN_ROOTS+=("$APP/Contents/Resources/canon-tree")
fi
NESTED=0
while IFS= read -r bin; do
    codesign "${SIGN_ARGS[@]}" "$bin" 2>/dev/null || {
        echo "    WARNING: could not sign $bin" >&2
    }
    NESTED=$((NESTED + 1))
done < <(find "${SIGN_ROOTS[@]}" -type f \
             \( -perm -u+x -o -name '*.dylib' -o -name '*.so' -o -name '*.node' \) \
         | while read -r f; do file -b "$f" | grep -q 'Mach-O' && echo "$f"; done)
echo "    signed $NESTED nested binaries"

echo "    signing the bundle"
codesign "${SIGN_ARGS[@]}" "$APP"
codesign --verify --strict --verbose=2 "$APP"

if [ "$IDENTITY" = "-" ]; then
    cat <<'EOF'
==> NOTE: ad-hoc signed. Gatekeeper WILL still warn on every other machine.
    Ad-hoc means "valid signature, no identity behind it", so recipients get
    the right-click > Open dance. To remove it entirely you need a paid Apple
    Developer ID. See canon_app/SIGNING.md for the full runbook.
EOF
else
    cat <<EOF
==> Signed with ${IDENTITY}. Notarize before sending it to anyone:
    ditto -c -k --keepParent "$APP" dist/StrategiCanon.zip
    xcrun notarytool submit dist/StrategiCanon.zip --keychain-profile canon-notary --wait
    xcrun stapler staple "$APP"
    See canon_app/SIGNING.md.
EOF
fi

echo "==> done: canon_app/dist/Strategi Canon.app"

#!/usr/bin/env bash
# Strategi Canon setup (macOS). Double-click me ONCE, before the first launch.
#
# If macOS refuses to open it ("unidentified developer"), right-click or
# Control-click this file, choose Open, then Open again. Once only, same as the
# app itself. That block comes from the file arriving in a download, not from
# anything it does.
cd "$(dirname "$0")" || exit 1

# Prefer the Python bundled inside the app, so setup needs nothing installed.
# Fall back to a system python3 only if the app has not unpacked its runtime yet.
APP_PY="Strategi Canon.app/Contents/Resources/runtimes/python/bin/python3"
if [ -x "$APP_PY" ]; then
    PY="$APP_PY"
else
    PY="$(command -v python3 || command -v python || true)"
fi

if [ -z "$PY" ]; then
    echo "No Python found to run setup."
    echo "Open \"Strategi Canon.app\" once so it unpacks its bundled Python, then run this again."
    echo
    echo "Press Return to close."
    read -r
    exit 1
fi

"$PY" canon_setup.py
echo
echo "Press Return to close this window."
read -r

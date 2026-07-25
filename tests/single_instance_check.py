#!/usr/bin/env python3
"""The single-instance lock: acquiring twice in one process fails the second time (that IS the
guard a second launch hits), and releasing frees the port so a restart can re-acquire."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "canon_app"))
import tray  # noqa: E402

assert tray.acquire_single_instance_lock() is True, "first acquire should win"
assert tray.acquire_single_instance_lock() is False, "second acquire must fail (lock held)"
tray.release_single_instance_lock()
assert tray.acquire_single_instance_lock() is True, "re-acquire should win after release"
tray.release_single_instance_lock()
print("PASS single-instance lock")

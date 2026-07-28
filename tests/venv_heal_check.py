"""_venv_base_ok decides whether an existing .venv is rebuilt. It is the whole App
Translocation self-heal, so pin its three cases. Run: python3 tests/venv_heal_check.py"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from launcher import _venv_base_ok  # noqa: E402


def main() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)

        # A real interpreter off any translocation mount: usable, keep the .venv.
        good_base = root / "runtime-python" / "bin"
        good_base.mkdir(parents=True)
        (good_base / "python3").write_text("#!/bin/sh\n")
        good_link = root / "venv_good" / "bin"
        good_link.mkdir(parents=True)
        (good_link / "python").symlink_to(good_base / "python3")
        assert _venv_base_ok(good_link / "python") is True, "stable base must be usable"

        # Dangling symlink (the base python is gone, e.g. a dead translocation mount): rebuild.
        dead = root / "venv_dead" / "bin"
        dead.mkdir(parents=True)
        (dead / "python").symlink_to(root / "gone" / "bin" / "python3")
        assert _venv_base_ok(dead / "python") is False, "dangling base must force a rebuild"

        # Base that resolves but lives on an AppTranslocation mount: still rebuild, because it
        # vanishes when this launch ends.
        trans = root / "x" / "AppTranslocation" / "UUID" / "d" / "app" / "bin"
        trans.mkdir(parents=True)
        (trans / "python3").write_text("#!/bin/sh\n")
        tlink = root / "venv_trans" / "bin"
        tlink.mkdir(parents=True)
        (tlink / "python").symlink_to(trans / "python3")
        assert _venv_base_ok(tlink / "python") is False, "translocated base must force a rebuild"

    print("venv_heal_check: ok")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Download the Node and Python runtimes that get bundled inside the app.

Why this exists: SETUP.md used to ask every recipient to install Node 20+ and
Python 3.11+ by hand before the app would start. Those two prerequisites are
what actually stalled non-technical people, so the build now carries both
runtimes inside the bundle and the recipient installs neither.

Run from the build scripts, before PyInstaller. Pure stdlib on purpose: this
runs in the throwaway build venv and must not need anything installed first.

Layout produced (gitignored, PyInstaller copies it in as `runtimes/`):

    build_assets/runtimes/node/bin/node      (node.exe at the root on Windows)
    build_assets/runtimes/python/bin/python3 (python.exe at the root on Windows)
    build_assets/runtimes/VERSIONS.json

Overrides: NODE_VERSION, PYTHON_VERSION, PBS_RELEASE. Pass --force to redownload.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# Pinned so a build is reproducible. Bump deliberately, not automatically: a
# silent runtime bump is a silent change to what every recipient runs.
NODE_VERSION = os.environ.get("NODE_VERSION", "24.18.0")      # LTS "Krypton"
PYTHON_VERSION = os.environ.get("PYTHON_VERSION", "3.12.13")
PBS_RELEASE = os.environ.get("PBS_RELEASE", "20260718")       # python-build-standalone tag

HERE = Path(__file__).resolve().parent
RUNTIMES = HERE / "build_assets" / "runtimes"
MARKER = RUNTIMES / "VERSIONS.json"


def log(msg: str) -> None:
    print(f"[runtimes] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Platform targets
# ---------------------------------------------------------------------------

def targets() -> tuple[str, str]:
    """Return (node_platform_slug, python_triple) for the machine we build on.

    Builds are per-platform: a macOS build produces a macOS app. Cross-building
    is deliberately unsupported, because a bundled runtime for the wrong OS
    fails at the recipient's first launch rather than at build time.
    """
    machine = platform.machine().lower()
    arm = machine in ("arm64", "aarch64")
    if sys.platform == "darwin":
        return (
            f"darwin-{'arm64' if arm else 'x64'}",
            f"{'aarch64' if arm else 'x86_64'}-apple-darwin",
        )
    if sys.platform == "win32":
        return (
            f"win-{'arm64' if arm else 'x64'}",
            f"{'aarch64' if arm else 'x86_64'}-pc-windows-msvc",
        )
    if sys.platform.startswith("linux"):
        return (
            f"linux-{'arm64' if arm else 'x64'}",
            f"{'aarch64' if arm else 'x86_64'}-unknown-linux-gnu",
        )
    raise SystemExit(f"unsupported build platform: {sys.platform} / {machine}")


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def download(url: str, dest: Path) -> None:
    log(f"GET {url}")
    try:
        with urllib.request.urlopen(url, timeout=180) as resp, dest.open("wb") as fh:
            shutil.copyfileobj(resp, fh)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"download failed ({exc.code}) for {url}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"download failed ({exc.reason}) for {url}") from exc
    log(f"  -> {dest.name} ({dest.stat().st_size // 1_048_576} MB)")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_text(url: str) -> str | None:
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return resp.read().decode("utf-8", "replace")
    except Exception:
        return None


def extract(archive: Path, into: Path) -> Path:
    """Extract and return the single top-level directory inside.

    Uses the `tar` filter rather than `data`: `data` normalises permission bits,
    which would strip the executable bit off `bin/node` and every shared object.
    These two sources are checksum-verified above, so `tar` is the right trade.
    """
    into.mkdir(parents=True, exist_ok=True)
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(into)
    else:
        with tarfile.open(archive) as tf:
            try:
                tf.extractall(into, filter="tar")
            except TypeError:      # Python < 3.12 has no filter kwarg
                tf.extractall(into)
    entries = [p for p in into.iterdir() if p.is_dir()]
    if len(entries) != 1:
        raise SystemExit(f"expected one top-level dir in {archive.name}, got {entries}")
    return entries[0]


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

def fetch_node(slug: str, staging: Path) -> None:
    is_win = slug.startswith("win-")
    ext = "zip" if is_win else "tar.gz"
    name = f"node-v{NODE_VERSION}-{slug}"
    url = f"https://nodejs.org/dist/v{NODE_VERSION}/{name}.{ext}"
    archive = staging / f"{name}.{ext}"
    download(url, archive)

    # nodejs.org publishes SHASUMS256.txt for every release. Verify, because a
    # corrupted runtime inside a signed bundle is a very confusing bug to chase.
    sums = fetch_text(f"https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt")
    if sums:
        expected = next(
            (line.split()[0] for line in sums.splitlines()
             if line.strip().endswith(f"  {archive.name}") or line.split()[-1] == archive.name),
            None,
        )
        if expected is None:
            raise SystemExit(f"{archive.name} not listed in SHASUMS256.txt")
        actual = sha256(archive)
        if actual != expected:
            raise SystemExit(f"checksum mismatch for {archive.name}:\n  want {expected}\n  got  {actual}")
        log("  checksum ok")
    else:
        log("  WARNING: could not fetch SHASUMS256.txt, skipping checksum")

    top = extract(archive, staging / "node-x")
    dest = RUNTIMES / "node"
    shutil.rmtree(dest, ignore_errors=True)
    shutil.move(str(top), str(dest))
    log(f"node {NODE_VERSION} -> {dest}")


# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------

def fetch_python(triple: str, staging: Path) -> None:
    asset = f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-{triple}-install_only_stripped.tar.gz"
    url = (
        "https://github.com/astral-sh/python-build-standalone/releases/download/"
        f"{PBS_RELEASE}/{asset}"
    )
    archive = staging / asset
    download(url, archive)

    # python-build-standalone publishes one combined SHA256SUMS per release,
    # not a .sha256 per asset.
    sums = fetch_text(
        f"https://github.com/astral-sh/python-build-standalone/releases/download/"
        f"{PBS_RELEASE}/SHA256SUMS"
    )
    if sums:
        expected = next(
            (line.split()[0] for line in sums.splitlines()
             if line.strip().split()[-1:] == [asset]),
            None,
        )
        if expected is None:
            raise SystemExit(f"{asset} not listed in SHA256SUMS for release {PBS_RELEASE}")
        actual = sha256(archive)
        if actual != expected:
            raise SystemExit(f"checksum mismatch for {asset}:\n  want {expected}\n  got  {actual}")
        log("  checksum ok")
    else:
        log("  WARNING: could not fetch SHA256SUMS, skipping checksum")

    top = extract(archive, staging / "py-x")   # install_only unpacks to python/
    dest = RUNTIMES / "python"
    shutil.rmtree(dest, ignore_errors=True)
    shutil.move(str(top), str(dest))
    log(f"cpython {PYTHON_VERSION} -> {dest}")


# ---------------------------------------------------------------------------
# Verify what we produced actually runs
# ---------------------------------------------------------------------------

def smoke_test() -> dict:
    """A bundled runtime that cannot execute is worse than no bundled runtime:
    it fails on the recipient's machine instead of here. Run both now."""
    import subprocess

    is_win = sys.platform == "win32"
    node = RUNTIMES / "node" / ("node.exe" if is_win else "bin/node")
    npm = RUNTIMES / "node" / ("npm.cmd" if is_win else "bin/npm")
    py = RUNTIMES / "python" / ("python.exe" if is_win else "bin/python3")

    results = {}
    for label, exe, args in (
        ("node", node, ["--version"]),
        ("python", py, ["--version"]),
    ):
        if not exe.exists():
            raise SystemExit(f"missing after extraction: {exe}")
        out = subprocess.run([str(exe), *args], capture_output=True, text=True, timeout=60)
        if out.returncode != 0:
            raise SystemExit(f"{label} failed to run: {out.stderr.strip()}")
        results[label] = out.stdout.strip() or out.stderr.strip()
        log(f"  {label}: {results[label]}")

    if not npm.exists():
        raise SystemExit(f"missing after extraction: {npm}")

    # The engine builds its .venv with this interpreter, so venv must be importable.
    out = subprocess.run([str(py), "-c", "import venv, ssl; print('venv+ssl ok')"],
                         capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise SystemExit(f"bundled python lacks venv/ssl support: {out.stderr.strip()}")
    log(f"  {out.stdout.strip()}")
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="redownload even if present")
    args = ap.parse_args()

    want = {"node": NODE_VERSION, "python": PYTHON_VERSION, "pbs": PBS_RELEASE}
    if MARKER.exists() and not args.force:
        try:
            if json.loads(MARKER.read_text())["want"] == want:
                log(f"already present: node {NODE_VERSION}, python {PYTHON_VERSION} (--force to redo)")
                return 0
        except Exception:
            pass

    node_slug, py_triple = targets()
    log(f"building for {sys.platform}: node {node_slug}, python {py_triple}")
    RUNTIMES.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="canon-runtimes-") as tmp:
        staging = Path(tmp)
        fetch_node(node_slug, staging)
        fetch_python(py_triple, staging)

    versions = smoke_test()
    MARKER.write_text(json.dumps(
        {"want": want, "resolved": versions, "node_slug": node_slug, "python_triple": py_triple},
        indent=2,
    ), encoding="utf-8")
    total = sum(f.stat().st_size for f in RUNTIMES.rglob("*") if f.is_file())
    log(f"done: {total // 1_048_576} MB in {RUNTIMES}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

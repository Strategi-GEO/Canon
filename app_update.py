#!/usr/bin/env python3
"""In-place app updater: pull the latest code-only release and swap it into the running tree.

WHY THIS IS SMALL EVEN THOUGH THE APP IS 300 MB. The heavy half of the app is the bundled
Node + Python runtimes, and they live in the read-only .app / installer, NOT in the tree the
engine runs from. Code (server/, dashboard/ prebuilt, launcher.py, .claude/) is the only part
that changes release to release, so an update fetches ONLY a code package (tens of MB) and
overlays it. The runtimes never re-download, outputs/ and clients/ are left alone, and
server/.env is preserved, so keys are never re-entered.

TWO-PHASE ON PURPOSE, and the split is what makes it safe on Windows. The engine (server/app.py)
calls stage(): download, checksum, extract, validate, mark PENDING. It does NOT overwrite the
running code, because on Windows a file a live process holds cannot be replaced. apply_pending()
runs at the NEXT tray launch, BEFORE the engine and dashboard children start, when nothing holds
those files, and does the actual swap with a full rollback. So "Update now" downloads; "Restart"
applies.

TRANSPORT is a private Supabase Storage bucket ('releases'), read with the service key the app
already fetched at login, so no GitHub token lives on a user's machine. Layout:
  releases/latest/<platform>/manifest.json   {"version","sha256","published"}
  releases/latest/<platform>/canon-update.tar.gz
<platform> is 'macos' or 'windows'. CI (build-canon-app.yml) writes both on a version tag.

SOURCE OF TRUTH stays Supabase for records; this module only moves CODE. Stdlib only: urllib,
tarfile, hashlib, shutil. Self-test at the bottom (python3 app_update.py).
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

# app_update.py sits at the tree root, beside launcher.py, so the tree is this file's folder.
TREE = Path(__file__).resolve().parent

BUCKET = "releases"
# outputs/ and clients/ are per-user scratch the record rebuilds; never overwrite them on a swap,
# exactly as tray.materialize_bundled_tree keeps them across a bundle upgrade. .venv is rebuilt by
# launcher.ensure_venv when requirements.txt changes (it stamps on the file's hash), so the swap
# leaves it and the next launch reinstalls if needed.
_KEEP = {"outputs", "clients", ".venv", ".canon-tree-stamp"}
_STAGING = ".canon-update-staging"
_PENDING = ".canon-update-pending"      # JSON marker: {"version": "..."} beside the tree
_BACKUP = ".canon-update-backup"


# --------------------------------------------------------------------------- platform / version

def platform_key() -> str | None:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("win"):
        return "windows"
    return None  # linux / dev: no package is published, so no update path


def _version_tuple(s: str) -> tuple[int, ...] | None:
    """'0.1.6' or 'v0.1.6' -> (0,1,6). Anything not a clean dotted number (e.g. 'dev') -> None,
    so a dev checkout never reports an update and a garbage manifest never triggers a swap."""
    s = (s or "").strip().lstrip("v")
    if not s:
        return None
    parts = s.split(".")
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        return None


def current_version(tree: Path = TREE) -> str:
    """The VERSION file CI writes into the tree, or 'dev' for a source checkout."""
    try:
        return (tree / "VERSION").read_text(encoding="utf-8").strip() or "dev"
    except OSError:
        return "dev"


# --------------------------------------------------------------------------- config / storage

def _load_env(tree: Path) -> dict[str, str]:
    """SUPABASE_URL and SUPABASE_SECRET_KEY out of server/.env. A local parser rather than
    importing server.db so this module stays usable from the tray, which never imports server.*."""
    env: dict[str, str] = {}
    try:
        for raw in (tree / "server" / ".env").read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    except OSError:
        pass
    return env


def _storage_get(env: dict[str, str], path: str, timeout: int = 60) -> bytes:
    """GET one object from the private bucket with the service key. Raises on any non-200."""
    base = env.get("SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SECRET_KEY", "")
    if not base or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SECRET_KEY missing; cannot check for updates")
    url = f"{base}/storage/v1/object/{BUCKET}/{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}", "apikey": key})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (fixed https host)
        return resp.read()


# --------------------------------------------------------------------------- check

def check(tree: Path = TREE) -> dict:
    """{current, latest, update_available, notes}. Never raises: a network or config problem
    reports update_available False with a note, so the Settings panel shows a reason, not a crash."""
    cur = current_version(tree)
    plat = platform_key()
    if plat is None:
        return {"current": cur, "latest": None, "update_available": False,
                "notes": "Updates are delivered to the packaged macOS and Windows apps only."}
    try:
        manifest = json.loads(_storage_get(_load_env(tree), f"latest/{plat}/manifest.json"))
    except Exception as exc:  # noqa: BLE001 (any failure is just 'cannot check right now')
        return {"current": cur, "latest": None, "update_available": False,
                "notes": f"Could not check for updates: {exc}"}
    latest = str(manifest.get("version", "")).strip()
    cur_t, latest_t = _version_tuple(cur), _version_tuple(latest)
    available = bool(cur_t and latest_t and latest_t > cur_t)
    note = ""
    if cur_t is None:
        note = "This is a development checkout, so automatic updates are off."
    elif not available:
        note = "You are on the latest version."
    return {"current": cur, "latest": latest or None, "update_available": available, "notes": note}


# --------------------------------------------------------------------------- stage (download)

def stage(tree: Path = TREE) -> dict:
    """Download + verify + extract the latest package and mark it PENDING for the next launch.
    Returns {ok, staged_version, restart_required}. Raises on a real failure (no update, bad
    checksum, unreadable package) so the endpoint can surface the reason."""
    info = check(tree)
    if not info["update_available"]:
        raise RuntimeError(info["notes"] or "No update is available.")
    plat = platform_key()
    env = _load_env(tree)
    manifest = json.loads(_storage_get(env, f"latest/{plat}/manifest.json"))
    version = str(manifest["version"]).strip()
    want_sha = str(manifest.get("sha256", "")).strip()

    blob = _storage_get(env, f"latest/{plat}/canon-update.tar.gz", timeout=600)
    if want_sha and hashlib.sha256(blob).hexdigest() != want_sha:
        raise RuntimeError("Downloaded update failed its checksum; not applying it.")

    staging = tree.parent / _STAGING
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    tmp = tree.parent / "canon-update.tar.gz"
    tmp.write_bytes(blob)
    try:
        with tarfile.open(tmp, "r:gz") as tar:
            _safe_extract(tar, staging)
    finally:
        tmp.unlink(missing_ok=True)

    root = _package_root(staging)
    if root is None:
        shutil.rmtree(staging, ignore_errors=True)
        raise RuntimeError("Update package is missing launcher.py / server/app.py; refusing it.")

    (tree.parent / _PENDING).write_text(
        json.dumps({"version": version, "root": str(root)}), encoding="utf-8")
    return {"ok": True, "staged_version": version, "restart_required": True}


def _safe_extract(tar: tarfile.TarFile, dest: Path) -> None:
    """Reject any member that would escape dest (path traversal) before extracting."""
    dest = dest.resolve()
    for member in tar.getmembers():
        target = (dest / member.name).resolve()
        if not str(target).startswith(str(dest)):
            raise RuntimeError(f"Unsafe path in update package: {member.name}")
    tar.extractall(dest)  # noqa: S202 (members validated above)


def _package_root(staging: Path) -> Path | None:
    """The tarball may hold the tree at its top level or nested one dir deep. Return whichever
    dir actually holds launcher.py + server/app.py, or None if neither does."""
    for candidate in (staging, *[p for p in staging.iterdir() if p.is_dir()]):
        if (candidate / "launcher.py").is_file() and (candidate / "server" / "app.py").is_file():
            return candidate
    return None


# --------------------------------------------------------------------------- apply (at launch)

def apply_pending(tree: Path = TREE) -> dict | None:
    """Swap a staged update into the tree if one is pending and newer. Called by the tray at
    launch, before any child starts. Returns {applied, version} on a swap, None when there is
    nothing to do. NEVER raises: on any failure it rolls the tree back byte for byte and returns
    an {applied: False, error} dict, because a half-applied swap is the one thing that bricks the
    app."""
    marker = tree.parent / _PENDING
    staging = tree.parent / _STAGING
    if not marker.is_file():
        return None
    try:
        pending = json.loads(marker.read_text(encoding="utf-8"))
        root = Path(pending.get("root", ""))
        version = str(pending.get("version", "")).strip()
    except (OSError, json.JSONDecodeError, ValueError):
        _clear_pending(tree)
        return None

    cur_t, new_t = _version_tuple(current_version(tree)), _version_tuple(version)
    if not root.is_dir() or not (root / "launcher.py").is_file() or new_t is None or (
            cur_t is not None and new_t <= cur_t):
        # Stale, invalid, or not actually newer (e.g. a fresh .app already carried it): drop it.
        _clear_pending(tree)
        return None

    backup = tree.parent / _BACKUP
    if backup.exists():
        shutil.rmtree(backup, ignore_errors=True)
    backup.mkdir(parents=True, exist_ok=True)
    env_bytes = _read_env(tree)
    moved: list[str] = []
    try:
        for entry in sorted(root.iterdir()):
            name = entry.name
            if name in _KEEP:
                continue
            _replace(tree, name, entry, backup, moved)
        _restore_env(tree, env_bytes)
        (tree / "VERSION").write_text(version + "\n", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 (roll back whatever we touched, then report)
        _rollback(tree, backup, moved)
        _restore_env(tree, env_bytes)
        return {"applied": False, "error": str(exc)}

    shutil.rmtree(backup, ignore_errors=True)
    _clear_pending(tree)
    return {"applied": True, "version": version}


def _replace(tree: Path, name: str, src: Path, backup: Path, moved: list[str]) -> None:
    """Move the current tree/<name> into backup, then copy the staged one in. Recorded in `moved`
    so a later failure can put every original back."""
    target = tree / name
    if target.exists() or target.is_symlink():
        target.rename(backup / name)
        moved.append(name)
    if src.is_dir():
        shutil.copytree(src, target, symlinks=True)
    else:
        shutil.copy2(src, target)


def _rollback(tree: Path, backup: Path, moved: list[str]) -> None:
    for name in moved:
        target = tree / name
        if target.exists() or target.is_symlink():
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target, ignore_errors=True)
            else:
                target.unlink(missing_ok=True)
        src = backup / name
        if src.exists():
            src.rename(target)
    shutil.rmtree(backup, ignore_errors=True)


def _read_env(tree: Path) -> bytes | None:
    try:
        return (tree / "server" / ".env").read_bytes()
    except OSError:
        return None


def _restore_env(tree: Path, data: bytes | None) -> None:
    if data is None:
        return
    env = tree / "server" / ".env"
    if not env.is_file():  # server/ was just replaced, so the keys would be gone without this
        env.parent.mkdir(parents=True, exist_ok=True)
        env.write_bytes(data)


def _clear_pending(tree: Path) -> None:
    (tree.parent / _PENDING).unlink(missing_ok=True)
    shutil.rmtree(tree.parent / _STAGING, ignore_errors=True)


# --------------------------------------------------------------------------- self-test

def _demo() -> None:
    """python3 app_update.py: a swap that preserves state, and a broken swap that rolls back."""
    import tempfile

    assert _version_tuple("v0.1.6") == (0, 1, 6)
    assert _version_tuple("dev") is None
    assert _version_tuple("0.2.0") > _version_tuple("0.1.9")

    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        tree = base / "app"

        def seed_tree(version: str) -> None:
            (tree / "server").mkdir(parents=True, exist_ok=True)
            (tree / "server" / "app.py").write_text(f"# v{version}", encoding="utf-8")
            (tree / "server" / ".env").write_text("SUPABASE_URL=x\n", encoding="utf-8")
            (tree / "launcher.py").write_text(f"# launcher v{version}", encoding="utf-8")
            (tree / "VERSION").write_text("0.1.0\n", encoding="utf-8")
            (tree / "outputs").mkdir(exist_ok=True)
            (tree / "outputs" / "keep.md").write_text("local work", encoding="utf-8")

        def stage_new(version: str, break_it: bool = False) -> None:
            root = base / _STAGING / "canon"
            (root / "server").mkdir(parents=True, exist_ok=True)
            (root / "server" / "app.py").write_text(f"# v{version} NEW", encoding="utf-8")
            (root / "launcher.py").write_text(f"# launcher v{version} NEW", encoding="utf-8")
            (root / "VERSION").write_text(version + "\n", encoding="utf-8")
            (base / _PENDING).write_text(
                json.dumps({"version": version, "root": str(root)}), encoding="utf-8")
            if break_it:
                # A file whose parent is a file, so copytree raises mid-swap -> forces rollback.
                (root / "server").rename(root / "server_dir")
                (root / "server").write_text("not a dir", encoding="utf-8")
                (root / "server_dir").rename(root / "server_x")

        # 1. happy path: code swaps, .env and outputs survive, VERSION bumps.
        seed_tree("0.1.0")
        stage_new("0.2.0")
        result = apply_pending(tree)
        assert result == {"applied": True, "version": "0.2.0"}, result
        assert "NEW" in (tree / "server" / "app.py").read_text()
        assert current_version(tree) == "0.2.0"
        assert (tree / "server" / ".env").read_text() == "SUPABASE_URL=x\n"
        assert (tree / "outputs" / "keep.md").read_text() == "local work"
        assert not (base / _PENDING).exists()

        # 2. not newer: a pending update <= current is dropped, tree untouched.
        stage_new("0.2.0")
        assert apply_pending(tree) is None
        assert not (base / _PENDING).exists()

        # 3. broken package: rollback restores the ORIGINAL code and keeps the env.
        shutil.rmtree(tree)
        seed_tree("0.1.0")
        stage_new("0.3.0", break_it=True)
        result = apply_pending(tree)
        assert result and result["applied"] is False, result
        assert current_version(tree) == "0.1.0", "version must not move on a failed swap"
        assert (tree / "server" / "app.py").read_text() == "# v0.1.0", "code must be original"
        assert (tree / "server" / ".env").read_text() == "SUPABASE_URL=x\n"

    print("app_update self-test: OK")


if __name__ == "__main__":
    _demo()

#!/usr/bin/env python3
"""Strategi Canon tray app: the menu-bar (macOS) / system-tray (Windows) face
of launcher.py.

launcher.py is the engine room: preflight, creds lift, env building, port
reclaim, child start/stop. This file wraps it in a status icon and a tiny
menu so a non-technical coworker never sees a terminal:

  - GREEN dot:  engine (and dashboard) healthy
  - AMBER dot:  setup needs attention; the menu lists each problem + its fix
  - RED dot:    a child died; "Restart" is the path back

Everything this app and its children print goes to log files under
~/Library/Logs/StrategiCanon (macOS) or %LOCALAPPDATA%\\StrategiCanon\\logs
(Windows). No credential value is ever logged: launcher.py logs credential
NAMES only, and the engine child never prints values either.

Env overrides for testing:
  CANON_ENGINE_PORT     engine port (default 8000)
  CANON_DASHBOARD_PORT  dashboard port (default 3000)
  CANON_NO_DASHBOARD=1  engine only, like the CLI's --no-dashboard
  CANON_NO_BROWSER=1    do not open the browser, like --no-browser
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import traceback
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

APP_NAME = "Strategi Canon"
CONFIG_PATH = Path.home() / ".strategi-canon.json"
HERE = Path(__file__).resolve().parent
IS_WINDOWS = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"
IS_FROZEN = bool(getattr(sys, "frozen", False))

GREEN = "#22a06b"   # healthy
AMBER = "#b7791f"   # setup needs attention
RED = "#c53030"     # a child died


# ---------------------------------------------------------------------------
# Logging: everything under the OS's log folder, tray included
# ---------------------------------------------------------------------------

def log_dir() -> Path:
    if IS_MAC:
        return Path.home() / "Library" / "Logs" / "StrategiCanon"
    if IS_WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "StrategiCanon" / "logs"
    return Path.home() / ".strategi-canon" / "logs"


LOG_DIR = log_dir()
_tray_log_handle = None


def _setup_tray_logging() -> None:
    """Send this process's stdout/stderr (launcher's [canon] prints included)
    to tray.log. A windowed frozen app has no console, so without this every
    print would be lost and every uncaught traceback invisible."""
    global _tray_log_handle
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    _tray_log_handle = open(LOG_DIR / "tray.log", "a", buffering=1, encoding="utf-8", errors="replace")
    sys.stdout = _tray_log_handle
    sys.stderr = _tray_log_handle


def tlog(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[tray {ts}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# PATH augmentation: Finder-launched apps get a minimal PATH
# ---------------------------------------------------------------------------

def bundled_runtimes_dir() -> Path | None:
    """Where the Node and Python runtimes shipped inside the app live, or None
    when this is a source checkout that has not run fetch_runtimes.py.

    Bundling both is what removed "install Node 20+" and "install Python 3.11+"
    from the recipient's prerequisites. See fetch_runtimes.py.

    The build scripts copy the runtimes in themselves rather than handing them
    to PyInstaller's --add-data, which resolves symlinks: Node's bin/npm points
    at ../lib/node_modules/npm/bin/npm-cli.js and Python's bin/python3 points at
    python3.12, and flattening either breaks the runtime. So look in the places
    a plain copy puts them, not just PyInstaller's _MEIPASS."""
    candidates: list[Path] = []
    if IS_FROZEN:
        exe_dir = Path(sys.executable).resolve().parent
        if IS_MAC:
            candidates.append(exe_dir.parent / "Resources" / "runtimes")  # .app/Contents/Resources
        candidates.append(exe_dir / "runtimes")                           # onedir sibling (Windows)
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(Path(meipass) / "runtimes")
    else:
        candidates.append(HERE / "build_assets" / "runtimes")

    return next((c for c in candidates if c.is_dir()), None)


def bundled_node_bin() -> Path | None:
    """Directory holding the bundled node/npm executables, if bundled."""
    runtimes = bundled_runtimes_dir()
    if runtimes is None:
        return None
    node_dir = runtimes / "node" if IS_WINDOWS else runtimes / "node" / "bin"
    exe = node_dir / ("node.exe" if IS_WINDOWS else "node")
    return node_dir if exe.exists() else None


def bundled_python() -> Path | None:
    """The bundled interpreter used to build the engine's .venv, if bundled."""
    runtimes = bundled_runtimes_dir()
    if runtimes is None:
        return None
    exe = runtimes / "python" / ("python.exe" if IS_WINDOWS else "bin/python3")
    return exe if exe.exists() else None


def augment_path() -> None:
    """Put the bundled runtimes first, then the usual hand-install locations.

    A macOS app launched from Finder inherits /usr/bin:/bin:/usr/sbin:/sbin, so
    node, npm, and claude installed by Homebrew or npm are invisible to
    shutil.which. Prepend the locations that actually exist. Windows GUI apps
    inherit the system PATH the installers already updated, but the bundled
    runtime still goes in front there.

    Bundled Node goes FIRST deliberately: the recipient may also have some other
    Node on PATH, and the version we tested the dashboard against is the one
    that should run it."""
    entries: list[str] = []

    node_bin = bundled_node_bin()
    if node_bin is not None:
        entries.append(str(node_bin))

    if not IS_WINDOWS:
        home = Path.home()
        entries += [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            str(home / ".local" / "bin"),
            str(home / ".claude" / "local"),      # Claude Code local install
            str(home / ".npm-global" / "bin"),
            str(home / "n" / "bin"),
        ]

    current = os.environ.get("PATH", "").split(os.pathsep)
    added = [e for e in entries if e not in current and Path(e).is_dir()]
    if added:
        os.environ["PATH"] = os.pathsep.join(added + current)
        tlog(f"PATH augmented with: {', '.join(added)}")
    if node_bin is not None:
        tlog(f"using bundled node from {node_bin}")


# ---------------------------------------------------------------------------
# Repo discovery
# ---------------------------------------------------------------------------

def looks_like_repo(p: Path) -> bool:
    return (p / "launcher.py").is_file() and (p / "server" / "app.py").is_file()


def bundled_tree_dir() -> Path | None:
    """The Canon source tree shipped INSIDE the app bundle (single-app builds), or None.

    The single-app package embeds the whole tree (server/, dashboard with its prebuilt
    standalone build, launcher.py, .claude/, clients/ templates) at
    Contents/Resources/canon-tree, beside the runtimes. A folder-release build has no such
    directory, which is exactly how the two layouts are told apart."""
    if not IS_FROZEN:
        return None
    exe_dir = Path(sys.executable).resolve().parent
    candidates = []
    if IS_MAC:
        candidates.append(exe_dir.parent / "Resources" / "canon-tree")  # .app/Contents/Resources
    candidates.append(exe_dir / "canon-tree")                           # onedir sibling (Windows)
    for candidate in candidates:
        if (candidate / "launcher.py").is_file() and (candidate / "server" / "app.py").is_file():
            return candidate
    return None


def data_tree_dir() -> Path:
    """Where the single-app build RUNS the tree from: a writable per-user data folder.

    The bundle's insides are sealed by its signature and must stay read-only, but the engine
    writes beside its code (.venv, outputs/, clients/ scratch, status files), so the tree is
    copied out once and run from here. Rebuildable state only: the record stays in Supabase,
    so losing this folder costs a re-materialize, never data."""
    if IS_WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "StrategiCanon" / "app"
    return Path.home() / "Library" / "Application Support" / "StrategiCanon" / "app"


def app_folder() -> Path:
    """The folder the user sees the app in: where the .app (or .exe folder) sits, and where
    the single-app layout looks for the operator's .env."""
    exe = Path(sys.executable).resolve()
    if IS_MAC and IS_FROZEN:
        # .app/Contents/MacOS/binary -> parents[2] is the .app, parents[3] its folder.
        try:
            return exe.parents[3] if exe.parents[2].suffix == ".app" else exe.parent
        except IndexError:
            return exe.parent
    return exe.parent


def external_env_path() -> Path | None:
    """The operator's env file beside the app, or None. `.env` is the name admins already
    hand out; `canon.env` is accepted too because Finder hides dotfiles and a visible name
    is the difference between 'drop the file next to the app' working and not."""
    folder = app_folder()
    for name in (".env", "canon.env"):
        candidate = folder / name
        if candidate.is_file():
            return candidate
    return None


def sync_external_env(tree: Path) -> None:
    """Copy the env beside the app into the tree the engine reads (server/.env). Runs at
    every startup and restart, so editing the file beside the app takes effect on Restart.
    A copy, not a symlink: a symlink dangles when the user moves the app, and a dangling
    server/.env fails much more confusingly than a stale one."""
    src = external_env_path()
    if src is None:
        return
    try:
        dest = tree / "server" / ".env"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
        tlog(f"env synced from {src}")
    except OSError as exc:
        tlog(f"could not sync {src} into the tree: {exc}")


def _copy_tree(src: Path, dest: Path) -> None:
    """ditto on macOS (preserves symlinks, modes and executable bits, battle-tested for the
    runtimes in this repo), shutil fallback elsewhere."""
    if IS_MAC and shutil_which("ditto"):
        subprocess.run(["ditto", str(src), str(dest)], check=True)
        return
    import shutil
    shutil.copytree(src, dest, symlinks=True)


def shutil_which(name: str) -> str | None:
    import shutil
    return shutil.which(name)


def _tree_version(path: Path) -> tuple[int, ...] | None:
    """The VERSION file's dotted number as a comparable tuple, or None when absent or not a clean
    number. Used to keep an in-app update (app_update.apply_pending bumps VERSION) from being
    reverted by an OLDER bundle on the next launch: materialize compares versions, not just the sha
    stamp, so a data tree that is the same version or newer than the bundle is never re-laid."""
    try:
        s = (path / "VERSION").read_text(encoding="utf-8").strip().lstrip("v")
    except OSError:
        return None
    if not s:
        return None
    try:
        return tuple(int(p) for p in s.split("."))
    except ValueError:
        return None


def materialize_bundled_tree(bundle: Path) -> Path:
    """Lay the bundled tree down in the data folder and return it. Idempotent and stamped:
    the CI writes .canon-tree-stamp (the commit sha) into the bundle, and a matching stamp on
    disk means the copy is current, so every launch after the first is a stat and a read.

    ON UPGRADE (stamp mismatch) CODE IS REPLACED AND STATE IS KEPT: every top-level entry the
    bundle carries is replaced EXCEPT outputs/ and clients/, which are per-user scratch the
    record can rebuild but local runs may be ahead of. server/.env is stashed across the
    server/ replace and restored, so an upgrade never costs the operator their keys even if
    the copy beside the app was deleted."""
    dest = data_tree_dir()
    stamp_name = ".canon-tree-stamp"
    try:
        bundle_stamp = (bundle / stamp_name).read_text(encoding="utf-8").strip()
    except OSError:
        bundle_stamp = "unstamped"
    try:
        dest_stamp = (dest / stamp_name).read_text(encoding="utf-8").strip()
    except OSError:
        dest_stamp = None

    if looks_like_repo(dest):
        bundle_ver, dest_ver = _tree_version(bundle), _tree_version(dest)
        if bundle_ver is not None and dest_ver is not None:
            # VERSION on both: the version decides. A data tree the SAME version or NEWER than the
            # bundle is left alone, which is exactly what protects an in-app update (VERSION bumped
            # above the shipped bundle) from being reverted here. A newer bundle (a freshly
            # installed .app) wins and re-lays.
            if dest_ver >= bundle_ver:
                return dest
        elif dest_stamp == bundle_stamp:
            # Pre-VERSION build (either side): fall back to the sha-stamp equality this always used.
            return dest

    tlog(f"materializing bundled tree {bundle_stamp!r} over {dest_stamp!r} at {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    env_stash = None
    env_file = dest / "server" / ".env"
    if env_file.is_file():
        env_stash = env_file.read_bytes()

    import shutil
    for entry in sorted(bundle.iterdir()):
        if entry.name == stamp_name:
            continue
        target = dest / entry.name
        if entry.name in ("outputs", "clients") and target.exists():
            continue
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        elif target.exists() or target.is_symlink():
            target.unlink()
        if entry.is_dir():
            _copy_tree(entry, target)
        else:
            shutil.copy2(entry, target)

    if env_stash is not None and not env_file.is_file():
        env_file.parent.mkdir(parents=True, exist_ok=True)
        env_file.write_bytes(env_stash)
    (dest / stamp_name).write_text(bundle_stamp + "\n", encoding="utf-8")
    tlog(f"materialized bundled tree at {dest}")
    return dest


def _mac_choose_folder() -> str | None:
    """A folder picker via osascript (choose folder), returning a POSIX path or None if cancelled.
    Used instead of tkinter.filedialog on macOS, where Tk crashes the pystray app (see the picker
    call site and secrets_bootstrap._prompt_login_mac)."""
    script = ('POSIX path of (choose folder with prompt '
              '"Select the Strategi Canon folder (the one containing launcher.py)")')
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    return r.stdout.rstrip("\n") or None


def discover_repo() -> Path | None:
    """(a) walk UP from the executable/frozen location and from this file, (b) the tree
    bundled inside a single-app build, materialized to the data folder, (c) the stored path
    in ~/.strategi-canon.json, (d) a tkinter folder picker persisted to (c). Returns None
    when all fail; the caller shows a native-ish error and exits.

    The walk-up stays FIRST so the folder release keeps working exactly as before: its .app
    sits inside the tree, has no bundled canon-tree, and finds the siblings it always found."""
    starts: list[Path] = []
    if IS_FROZEN:
        starts.append(Path(sys.executable).resolve())
    starts.append(Path(__file__).resolve())
    for start in starts:
        for candidate in [start] + list(start.parents):
            try:
                if candidate.is_dir() and looks_like_repo(candidate):
                    tlog(f"repo discovered by walking up from {start}: {candidate}")
                    return candidate
            except OSError:
                continue

    bundle = bundled_tree_dir()
    if bundle is not None:
        try:
            tree = materialize_bundled_tree(bundle)
            sync_external_env(tree)
            return tree
        except Exception:
            tlog("bundled tree materialization failed:\n" + traceback.format_exc())
            # Fall through: the stored path or the picker may still rescue this launch.

    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        stored = Path(str(cfg.get("repo", "")))
        if stored and looks_like_repo(stored):
            tlog(f"repo from {CONFIG_PATH}: {stored}")
            return stored
        tlog(f"stored repo path in {CONFIG_PATH} is missing or no longer a repo: {stored}")
    except (OSError, json.JSONDecodeError, ValueError):
        pass

    try:
        if IS_MAC:
            # osascript, NOT tkinter: importing Tk installs TKApplication as the shared NSApp and
            # the next pystray menu validation panics (SIGABRT). Same reason as the sign-in dialog,
            # see secrets_bootstrap._prompt_login_mac.
            chosen = _mac_choose_folder()
        else:
            import tkinter
            import tkinter.filedialog
            root = tkinter.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            chosen = tkinter.filedialog.askdirectory(
                title="Select the Strategi Canon folder (the one containing launcher.py)"
            )
            root.destroy()
        if chosen and looks_like_repo(Path(chosen)):
            CONFIG_PATH.write_text(json.dumps({"repo": chosen}), encoding="utf-8")
            tlog(f"repo picked and persisted to {CONFIG_PATH}: {chosen}")
            return Path(chosen)
        if chosen:
            tlog(f"picked folder is not a Canon repo (no launcher.py + server/app.py): {chosen}")
    except Exception as exc:  # tkinter missing or headless: fall through to the error path
        tlog(f"folder picker unavailable or failed: {exc}")
    return None


def native_error(msg: str) -> None:
    tlog(f"FATAL: {msg}")
    try:
        if IS_MAC:
            subprocess.run(
                ["osascript", "-e",
                 f'display dialog "{msg}" with title "{APP_NAME}" buttons {{"OK"}} '
                 'default button "OK" with icon caution'],
                capture_output=True, timeout=120,
            )
        elif IS_WINDOWS:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, msg, APP_NAME, 0x10)  # MB_ICONERROR
    except Exception:
        pass


def load_launcher(repo: Path):
    spec = importlib.util.spec_from_file_location("launcher", repo / "launcher.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["launcher"] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# Claude account (best effort, display only)
# ---------------------------------------------------------------------------

def claude_account_email() -> str | None:
    """~/.claude.json holds oauthAccount.emailAddress on a logged-in machine
    (probed on a real install). Best effort: any failure means 'omit the
    menu item', never an error."""
    try:
        data = json.loads((Path.home() / ".claude.json").read_text(encoding="utf-8"))
        account = data.get("oauthAccount")
        if isinstance(account, dict):
            email = account.get("emailAddress")
            if email:
                return str(email)
    except (OSError, json.JSONDecodeError, ValueError):
        pass
    return None


# ---------------------------------------------------------------------------
# System python (frozen apps cannot use sys.executable to create the venv)
# ---------------------------------------------------------------------------

def find_system_python() -> str | None:
    """Return an interpreter able to create the engine's .venv, or None.

    Inside a PyInstaller app sys.executable is the app binary, which cannot
    create a venv, so a real interpreter is needed. The bundled one ships with
    the app and is tried first: that is what lets a recipient who has never
    installed Python run the engine. Falling back to PATH keeps source
    checkouts and pre-bundling installs working."""
    bundled = bundled_python()
    if bundled is not None:
        tlog(f"using bundled python at {bundled}")
        return str(bundled)

    import shutil as _shutil
    for name in ("python3", "python") if not IS_WINDOWS else ("py", "python", "python3"):
        path = _shutil.which(name)
        if not path:
            continue
        try:
            out = subprocess.run(
                [path, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
                capture_output=True, text=True, timeout=15,
            )
            major, minor = (int(x) for x in out.stdout.split())
            if (major, minor) >= (3, 11):
                return path
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Children die with the tray, even on an unclean kill
# ---------------------------------------------------------------------------

_win_job_handle = None


def _ensure_windows_job():
    """One kill-on-close Job Object for all children. When this process dies,
    for ANY reason, the OS closes the handle and kills every assigned process
    tree. This is the Windows analogue of the POSIX reaper below."""
    global _win_job_handle
    if _win_job_handle is not None:
        return _win_job_handle
    import ctypes
    from ctypes import wintypes

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
            ("IoInfo", IO_COUNTERS),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.windll.kernel32
    # EXPLICIT ctypes signatures, or the reaper silently fails. A HANDLE is pointer-sized on
    # 64-bit Windows, but ctypes' default restype is c_int (signed 32-bit): a handle value with
    # bit 31 set comes back negative and is sign-extended to garbage when passed to the next
    # call, so the job assignment or close no-ops and children orphan on an unclean tray exit.
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                                 wintypes.LPVOID, wintypes.DWORD]
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        tlog("WARNING: CreateJobObjectW failed; children will not be reaped on an unclean tray exit")
        return None
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):  # 9 = JobObjectExtendedLimitInformation
        tlog("WARNING: SetInformationJobObject failed; the job will not kill children on close")
    _win_job_handle = job
    return job


def tie_child_to_tray(proc: subprocess.Popen) -> None:
    """Guarantee the child dies when the tray does, clean quit or not.

    POSIX: a tiny /bin/sh babysitter polls the tray pid; when the tray is
    gone it kills the child's process group (the child is its own group,
    launcher.spawn uses start_new_session). Python signal handlers are NOT
    reliable here: on macOS the main thread sits inside the AppKit run loop,
    where a Python-level handler may never get to run.

    Windows: assign the child to a kill-on-close Job Object owned by this
    process; descendants inherit the job, so the npm/cmd tree dies too."""
    try:
        if IS_WINDOWS:
            import ctypes
            from ctypes import wintypes
            job = _ensure_windows_job()
            if not job:
                return
            kernel32 = ctypes.windll.kernel32
            # Same HANDLE-truncation trap as _ensure_windows_job: give OpenProcess a HANDLE
            # restype so a high-bit handle is not mangled before AssignProcessToJobObject sees it.
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
            kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            PROCESS_SET_QUOTA, PROCESS_TERMINATE = 0x0100, 0x0001
            handle = kernel32.OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, proc.pid)
            if handle:
                if not kernel32.AssignProcessToJobObject(job, handle):
                    tlog(f"WARNING: could not assign pid {proc.pid} to the kill-on-close job; "
                         f"it may orphan on an unclean tray exit")
                kernel32.CloseHandle(handle)
        else:
            # Exit when EITHER the tray dies (kill the child) OR the child is already gone (a
            # menu Restart kills the old children while the tray lives on, and without the child
            # check these babysitters would sleep forever, leaking two sh processes per restart).
            script = (
                f"while kill -0 {os.getpid()} 2>/dev/null && kill -0 {proc.pid} 2>/dev/null; "
                f"do sleep 2; done; "
                f"kill -TERM -{proc.pid} 2>/dev/null; sleep 5; "
                f"kill -KILL -{proc.pid} 2>/dev/null"
            )
            subprocess.Popen(
                ["/bin/sh", "-c", script],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
    except Exception as exc:
        tlog(f"WARNING: could not tie child pid {proc.pid} to the tray's lifetime: {exc}")


# ---------------------------------------------------------------------------
# Icon rendering (runtime, Pillow, no binary assets)
# ---------------------------------------------------------------------------

def dot_image(color: str):
    """A filled rounded dot. 22x22 with padding for the macOS menu bar,
    32x32 for the Windows tray (pystray downscales for the 16px slot).
    Drawn supersampled then LANCZOS-resized so the edge is smooth."""
    from PIL import Image, ImageDraw
    size = 22 if IS_MAC else 32
    pad = 4 if IS_MAC else 5
    scale = 8
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.ellipse(
        [pad * scale, pad * scale, (size - pad) * scale, (size - pad) * scale],
        fill=color,
    )
    return canvas.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------------------
# Start at login: keep Canon resident so the project is up the moment it is opened
# ---------------------------------------------------------------------------

AUTOSTART_LABEL = "com.strategi.canon"

_MAC_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array><string>{program}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"""


def _mac_launch_agent_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{AUTOSTART_LABEL}.plist"


def autostart_supported() -> bool:
    """Only the packaged app can start at login: a login item points at a stable executable, and
    a source checkout run through a system Python has none. So the menu offers this only when
    frozen, on the two platforms the package targets."""
    return IS_FROZEN and (IS_MAC or IS_WINDOWS)


def _autostart_target() -> str:
    """What a login item launches: the .app binary on macOS, the tray .exe on Windows, both of
    which are sys.executable inside a PyInstaller build."""
    return str(Path(sys.executable).resolve())


def autostart_enabled() -> bool:
    """Whether the login item is installed. Any failure reads as 'off' rather than raising into
    the menu, which polls this on every open."""
    try:
        if IS_MAC:
            return _mac_launch_agent_path().is_file()
        if IS_WINDOWS:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                try:
                    winreg.QueryValueEx(key, "StrategiCanon")
                    return True
                except FileNotFoundError:
                    return False
    except OSError:
        return False
    return False


def set_autostart(enable: bool) -> None:
    """Install or remove the login item. It WRITES the file/registry value only and never starts
    a process, so toggling it on while the app is already running does not spawn a second copy:
    the item takes effect at the next login. Once on, the app launches at login and its tray
    keeps the engine and the prebuilt dashboard resident, so opening it shows the project at once."""
    if IS_MAC:
        plist = _mac_launch_agent_path()
        if enable:
            plist.parent.mkdir(parents=True, exist_ok=True)
            plist.write_text(
                _MAC_PLIST.format(label=AUTOSTART_LABEL, program=_autostart_target()),
                encoding="utf-8")
        else:
            plist.unlink(missing_ok=True)
        return
    if IS_WINDOWS:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                            winreg.KEY_SET_VALUE) as key:
            if enable:
                winreg.SetValueEx(key, "StrategiCanon", 0, winreg.REG_SZ,
                                  f'"{_autostart_target()}"')
            else:
                try:
                    winreg.DeleteValue(key, "StrategiCanon")
                except FileNotFoundError:
                    pass


# ---------------------------------------------------------------------------
# The app
# ---------------------------------------------------------------------------

class CanonTray:
    def __init__(self, repo: Path, launcher) -> None:
        self.repo = repo
        self.launcher = launcher
        # Single-app mode: this tray is running a tree it materialized from its own bundle,
        # so the operator's .env lives BESIDE THE APP and is re-synced on every (re)start,
        # and the preflight's env message points there instead of at server/.env.
        self.single_app = bundled_tree_dir() is not None and repo == data_tree_dir()
        # The marker app_update.stage() writes beside the tree after a download. The watcher sees
        # it and restarts the app to apply the staged update (apply_pending runs in main()). Name
        # mirrors app_update._PENDING; a launch-time marker is already consumed by apply_pending in
        # main() before the watcher starts, so the watcher only ever sees one written THIS session.
        self._pending_marker = repo.parent / ".canon-update-pending"
        self.engine_port = self._env_port("CANON_ENGINE_PORT", 8000)
        self.dash_port = self._env_port("CANON_DASHBOARD_PORT", 3000)
        self.no_dashboard = os.environ.get("CANON_NO_DASHBOARD") == "1"
        self.no_browser = os.environ.get("CANON_NO_BROWSER") == "1"

        self.state = "starting"          # starting | problems | running | dead
        self.status_text = "Starting..."
        self.problems: list[dict] = []
        self.email = claude_account_email()
        self.engine_proc: subprocess.Popen | None = None
        self.dash_proc: subprocess.Popen | None = None
        self._child_logs: list = []
        self.browser_opened = False
        self.icon = None                 # set by main()
        self._transition = threading.Lock()   # one start/stop/restart at a time
        self._quitting = threading.Event()
        self._health_strikes = 0

    @staticmethod
    def _env_port(name: str, default: int) -> int:
        try:
            return int(os.environ.get(name, "") or default)
        except ValueError:
            return default

    # -- state / UI -------------------------------------------------------

    def _set_state(self, state: str, status_text: str) -> None:
        self.state = state
        self.status_text = status_text
        tlog(f"state -> {state}: {status_text}")
        if self.icon is not None:
            color = {"running": GREEN, "problems": AMBER, "dead": RED}.get(state, AMBER)
            try:
                self.icon.icon = dot_image(color)
                self.icon.update_menu()
            except Exception as exc:
                tlog(f"WARNING: icon update failed: {exc}")

    def menu_items(self):
        import pystray
        Item, Menu = pystray.MenuItem, pystray.Menu

        yield Item(lambda _: self.status_text, None, enabled=False)

        if self.state == "problems":
            for problem in self.problems:
                yield Item(f"✗ {problem['problem']}", None, enabled=False)
                yield Item(f"    Fix: {problem['fix']}", None, enabled=False)
            yield Item("Check again", self.on_check_setup)
            yield Item("Quit", self.on_quit)
            return

        if self.email:
            yield Item(f"Claude account: {self.email}", None, enabled=False)
        yield Menu.SEPARATOR
        yield Item("Open dashboard", self.on_open_dashboard)
        yield Item("Restart", self.on_restart, default=(self.state == "dead"))
        yield Item("Check setup again", self.on_check_setup)
        yield Item("Open logs", self.on_open_logs)
        if autostart_supported():
            # A checkbox: pystray re-reads `checked` each time the menu opens, so it reflects the
            # login item's real state even if it was changed elsewhere. Only shown on the packaged
            # app (autostart_supported), where a login item has a stable executable to point at.
            yield Item("Start at login", self.on_toggle_autostart,
                       checked=lambda item: autostart_enabled())
        yield Menu.SEPARATOR
        yield Item("Quit", self.on_quit)

    # -- preflight --------------------------------------------------------

    def run_preflight(self) -> list[dict]:
        checks = list(self.launcher.preflight_checks())
        env_check = self.launcher.env_file_check()
        if self.single_app and not env_check.get("ok"):
            # The launcher's wording points at server/.env inside the tree, which the
            # single-app operator never sees. Their env lives beside the app.
            env_check = dict(env_check, problem="No .env file found next to the app.",
                             fix='Put the .env file from your admin in the same folder as '
                                 '"Strategi Canon.app" (name it .env or canon.env), then '
                                 'choose "Check again".')
        checks.append(env_check)
        if IS_FROZEN and not self.launcher.venv_python().exists() and find_system_python() is None:
            # The launcher's own python check tests the interpreter bundled
            # inside this app, which is always fine; what a frozen app needs
            # is a SYSTEM python to create the engine's .venv with.
            checks.append({
                "name": "system-python", "ok": False,
                "problem": "Python 3.11+ is not installed, and the engine's Python environment (.venv) does not exist yet.",
                "fix": "Install Python 3.11 or newer from https://www.python.org/downloads/, then choose Check again.",
            })
        return [c for c in checks if not c["ok"]]

    # -- start / stop -----------------------------------------------------

    def _open_child_log(self, name: str):
        handle = open(LOG_DIR / name, "ab")
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        handle.write(f"\n===== {APP_NAME} start {ts} =====\n".encode())
        handle.flush()
        self._child_logs.append(handle)
        return handle

    def startup(self) -> None:
        with self._transition:
            if self._quitting.is_set():
                return
            try:
                self._set_state("starting", "Checking setup...")
                if self.single_app:
                    # Before preflight, which reads server/.env: a fresh or edited env beside
                    # the app must count on this very (re)start.
                    sync_external_env(self.repo)
                problems = self.run_preflight()
                if problems:
                    self.problems = problems
                    noun = "problem" if len(problems) == 1 else "problems"
                    self._set_state("problems", f"Setup needs attention: {len(problems)} {noun}")
                    return

                self._set_state("starting", "Preparing Python environment...")
                base_python = find_system_python() if IS_FROZEN else None
                py = self.launcher.ensure_venv_raise(base_python=base_python)

                engine_env = self.launcher.build_engine_env()
                self.launcher.billing_banner(engine_env)

                self.launcher.reclaim_port_raise(self.engine_port)
                if not self.no_dashboard:
                    self.launcher.reclaim_port_raise(self.dash_port)

                self._set_state("starting", f"Starting engine on :{self.engine_port}...")
                engine_log = self._open_child_log("engine.log")
                self.engine_proc = self.launcher.start_engine(
                    py, engine_env, self.engine_port,
                    stdout=engine_log, stderr=subprocess.STDOUT,
                )
                tie_child_to_tray(self.engine_proc)
                health = self.launcher.engine_health_url(self.engine_port)
                if not self.launcher.wait_for_http(health, self.engine_proc, "engine", timeout_s=120):
                    raise self.launcher.LauncherError(
                        "the engine never became healthy; see engine.log under Open logs")

                if not self.no_dashboard:
                    self._set_state("starting", "Preparing dashboard...")
                    # A packaged (prebuilt) dashboard needs NEITHER: it ships its own traced
                    # node_modules inside .next/standalone and has no dev cache to clear. Mirror
                    # launcher.main()'s guard, which the tray was missing: without it the packaged
                    # app ran a multi-minute `npm install` and sat on "Preparing dashboard..."
                    # instead of starting the compiled server in a second.
                    if self.launcher.prebuilt_dashboard_server() is None:
                        self.launcher.ensure_dashboard_deps_raise()
                        self.launcher.clear_next_cache()
                    self._set_state("starting", f"Starting dashboard on :{self.dash_port}...")
                    dash_log = self._open_child_log("dashboard.log")
                    self.dash_proc = self.launcher.start_dashboard(
                        self.dash_port, stdout=dash_log, stderr=subprocess.STDOUT,
                    )
                    tie_child_to_tray(self.dash_proc)
                    dash_url = f"http://localhost:{self.dash_port}/"
                    if not self.launcher.wait_for_http(dash_url, self.dash_proc, "dashboard", timeout_s=180):
                        raise self.launcher.LauncherError(
                            "the dashboard never became reachable; see dashboard.log under Open logs")
                    if not self.no_browser and not self.browser_opened:
                        webbrowser.open(dash_url)
                        self.browser_opened = True

                self._health_strikes = 0
                self._set_state("running", f"Engine running - :{self.engine_port}")
            except self.launcher.LauncherError as exc:
                tlog(f"startup failed: {exc}")
                self._stop_children_locked()
                self._set_state("dead", f"Start failed: {exc}")
            except Exception:
                tlog("startup crashed:\n" + traceback.format_exc())
                self._stop_children_locked()
                self._set_state("dead", "Start crashed; see tray.log under Open logs")

    def _stop_children_locked(self) -> None:
        """Callers must hold self._transition."""
        if self.dash_proc is not None:
            self.launcher.stop_process_tree(self.dash_proc, "dashboard")
            self.dash_proc = None
        if self.engine_proc is not None:
            self.launcher.stop_process_tree(self.engine_proc, "engine")
            self.engine_proc = None
        for handle in self._child_logs:
            try:
                handle.close()
            except OSError:
                pass
        self._child_logs = []

    def stop_children(self) -> None:
        with self._transition:
            self._stop_children_locked()

    # -- watcher ----------------------------------------------------------

    def watcher(self) -> None:
        """Every 10s: engine /api/health plus the dashboard port. Flips the
        icon and status line on change; a died child turns the dot RED with
        Restart highlighted as the path back."""
        while not self._quitting.wait(10):
            # A staged update is the operator having clicked "Update now"; apply it by relaunching
            # the app (main() -> app_update.apply_pending). Checked FIRST and in every state, so an
            # update downloaded while the engine is amber or dead still gets applied.
            if IS_FROZEN and self._pending_marker.exists():
                tlog("watcher: staged update detected, restarting to apply")
                self._set_state("starting", "Applying update, restarting...")
                self.restart_app()
                return
            if self.state not in ("running", "dead"):
                continue  # starting or amber: nothing to watch yet
            if self.engine_proc is None:
                continue

            if self.engine_proc.poll() is not None:
                if self.state != "dead":
                    self._set_state("dead", "Engine died - choose Restart")
                continue
            if self.dash_proc is not None and self.dash_proc.poll() is not None:
                if self.state != "dead":
                    self._set_state("dead", "Dashboard died - choose Restart")
                continue

            engine_ok = self._engine_healthy()
            dash_ok = self.no_dashboard or self.dash_proc is None or self._port_open(self.dash_port)
            if engine_ok and dash_ok:
                self._health_strikes = 0
                if self.state == "dead":
                    self._set_state("running", f"Engine running - :{self.engine_port}")
            else:
                self._health_strikes += 1
                if self._health_strikes >= 2 and self.state != "dead":
                    what = "Engine" if not engine_ok else "Dashboard"
                    self._set_state("dead", f"{what} not responding - choose Restart")

    def _engine_healthy(self) -> bool:
        try:
            url = self.launcher.engine_health_url(self.engine_port)
            with urllib.request.urlopen(url, timeout=4) as resp:
                return 200 <= resp.status < 400
        except (urllib.error.URLError, OSError, ValueError):
            return False

    @staticmethod
    def _port_open(port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=4):
                return True
        except OSError:
            return False

    # -- menu handlers (run work off the UI thread) -----------------------

    def on_open_dashboard(self, icon=None, item=None) -> None:
        webbrowser.open(f"http://localhost:{self.dash_port}/")

    def on_toggle_autostart(self, icon=None, item=None) -> None:
        """Flip the login item. Failures are logged, never raised into pystray's callback, and
        the menu is refreshed so the checkmark matches what actually landed on disk."""
        try:
            set_autostart(not autostart_enabled())
        except OSError as exc:
            tlog(f"start-at-login toggle failed: {exc}")
        if self.icon is not None:
            self.icon.update_menu()

    def on_restart(self, icon=None, item=None) -> None:
        def work():
            self._set_state("starting", "Restarting...")
            self.stop_children()
            self.startup()
        threading.Thread(target=work, name="canon-restart", daemon=True).start()

    def restart_app(self) -> None:
        """Relaunch the WHOLE app (not just the children) so main() re-runs and app_update.
        apply_pending swaps a staged update in before the engine and dashboard restart on the new
        code. This is the auto-apply half of an update: the engine stages the package and writes
        the pending marker, the watcher sees it and calls this. Unlike on_restart, which restarts
        the children under the same launcher held in memory, a relaunch also refreshes launcher.py
        and the tray itself."""
        self._quitting.set()
        self.stop_children()
        # Free the single-instance lock BEFORE the replacement launches, so the fresh instance
        # (Windows spawns a new process; macOS execs in place) can bind it without racing this one.
        release_single_instance_lock()
        exe = str(Path(sys.executable).resolve())
        tlog(f"restart_app: relaunching {exe} to apply a staged update")
        try:
            if IS_WINDOWS:
                # Windows has no in-place execv for a windowed app, so spawn a fresh DETACHED
                # instance and let this one fall out of the run loop and exit.
                DETACHED_PROCESS, CREATE_NEW_PROCESS_GROUP = 0x00000008, 0x00000200
                subprocess.Popen([exe], creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                                 close_fds=True)
                if self.icon is not None:
                    self.icon.stop()
            else:
                # Replace this process image, so there is never a second menu-bar icon and the same
                # pid re-enters main(). Children were stopped above, so nothing is left holding a port.
                os.execv(exe, [exe])
        except Exception:
            tlog("restart_app failed; the update applies on the next manual restart instead:\n"
                 + traceback.format_exc())

    def on_check_setup(self, icon=None, item=None) -> None:
        def work():
            self.email = claude_account_email()
            if self.state in ("problems", "dead") or self.engine_proc is None:
                # Nothing healthy is running: a clean re-check is a full boot.
                self.stop_children()
                self.startup()
                return
            # Healthy children keep running; just re-verify the setup.
            problems = self.run_preflight()
            if problems:
                names = ", ".join(p["name"] for p in problems)
                tlog(f"check setup: {len(problems)} problem(s) while running: {names}")
                for problem in problems:
                    tlog(f"  problem: {problem['problem']} fix: {problem['fix']}")
                self._set_state("running", f"Running, but setup has {len(problems)} problem(s); see tray.log")
            else:
                tlog("check setup: all clear")
                self._set_state("running", f"Engine running - :{self.engine_port}")
        threading.Thread(target=work, name="canon-check", daemon=True).start()

    def on_open_logs(self, icon=None, item=None) -> None:
        try:
            if IS_MAC:
                subprocess.Popen(["open", str(LOG_DIR)])
            elif IS_WINDOWS:
                subprocess.Popen(["explorer", str(LOG_DIR)])
            else:
                subprocess.Popen(["xdg-open", str(LOG_DIR)])
        except OSError as exc:
            tlog(f"WARNING: could not open log folder: {exc}")

    def on_quit(self, icon=None, item=None) -> None:
        def work():
            tlog("quit: stopping children")
            self._quitting.set()
            self.stop_children()
            tlog("quit: children stopped, exiting")
            if self.icon is not None:
                self.icon.stop()
        threading.Thread(target=work, name="canon-quit", daemon=True).start()

    # -- boot -------------------------------------------------------------

    def boot(self) -> None:
        threading.Thread(target=self.watcher, name="canon-watcher", daemon=True).start()
        self.startup()


# ---------------------------------------------------------------------------
# Single instance: a second launch must not fight the first over the ports
# ---------------------------------------------------------------------------

# A private loopback port used purely as a lock. Not the engine's 8000 or the dashboard's 3000,
# so reclaim_port never touches it. ponytail: rare false "already running" if unrelated software
# already holds this exact port; move it if that ever bites.
_SINGLE_INSTANCE_PORT = 8771
_instance_lock_socket: "socket.socket | None" = None


def acquire_single_instance_lock() -> bool:
    """True if this is the only instance; False if another already holds the lock.

    Holds a loopback socket bound to a fixed port for the whole process lifetime. A second
    instance fails to bind (SO_REUSEADDR deliberately OFF) and learns one is already up. The OS
    frees the port the instant this process dies, so a crash never leaves a stale lock behind,
    which is why this beats a lock file: no cleanup, no staleness."""
    global _instance_lock_socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", _SINGLE_INSTANCE_PORT))
    except OSError:
        sock.close()
        return False
    _instance_lock_socket = sock  # kept bound for the process lifetime
    return True


def release_single_instance_lock() -> None:
    """Free the lock so a replacement (an in-app update restart) can take it immediately."""
    global _instance_lock_socket
    if _instance_lock_socket is not None:
        try:
            _instance_lock_socket.close()
        except OSError:
            pass
        _instance_lock_socket = None


# NOTE deliberately NO Python-level SIGTERM/SIGINT handlers. The main thread
# spends its life inside the GUI run loop (AppKit on macOS, the win32 message
# pump on Windows), where a Python handler never gets to run: installing one
# REPLACES the default terminate disposition and the signal is swallowed, so
# a `kill` would leave a zombie tray. Verified live on macOS. With the OS
# default, a signal terminates the tray instantly and tie_child_to_tray's
# reaper (POSIX) / Job Object (Windows) takes the children down. The clean
# path is the menu's Quit, which stops children before exiting.


def main() -> int:
    _setup_tray_logging()
    tlog(f"=== {APP_NAME} tray starting (frozen={IS_FROZEN}, platform={sys.platform}) ===")

    # FIRST, before discovering the repo or starting anything: refuse to be a second instance.
    # Without this, a second launch reclaims (kills) the first instance's engine and dashboard,
    # the two fight over ports 8000/3000, and the operator sees an orange dot with no reachable
    # dashboard. One instance owns the ports; a second open just points back to it.
    if not acquire_single_instance_lock():
        tlog("another Strategi Canon instance already holds the lock; exiting this one")
        native_error(
            "Strategi Canon is already running. Look for its dot in the menu bar (macOS) or the "
            "system tray (Windows). If you cannot find it, quit it from there, then open it again."
        )
        return 0

    augment_path()

    # CA CERTIFICATES, BEFORE ANY HTTPS. This frozen app's bundled Python has no CA bundle wired
    # into OpenSSL, so secrets_bootstrap's Supabase sign-in fails CERTIFICATE_VERIFY_FAILED. Point
    # OpenSSL at the bundled certifi. Set in os.environ so the engine child inherits it too
    # (build_engine_env copies the environment); the engine also sets it from its own certifi.
    if IS_FROZEN:
        try:
            import certifi
            os.environ.setdefault("SSL_CERT_FILE", certifi.where())
            tlog(f"SSL_CERT_FILE -> {os.environ.get('SSL_CERT_FILE')}")
        except Exception:
            tlog("certifi unavailable; HTTPS falls back to the platform default CA path")

    repo = discover_repo()
    if repo is None:
        native_error(
            "Strategi Canon could not find its folder (the one containing launcher.py). "
            "Put the app inside the Canon folder you got from your admin, or pick the "
            "folder when asked, then open the app again."
        )
        return 1

    # SECRETS BOOTSTRAP (frozen only, fallback-safe): if there is no usable server/.env and the
    # app carries a filled-in public config, sign the operator in and fetch the engine keys from
    # Supabase, so they were never handed a .env file. Blank config (the shipped default) or an
    # existing env makes this a no-op, so the folder release and any machine that already has an
    # env are untouched. Runs here, before pystray takes the main thread, so the Tk sign-in
    # dialog has it.
    if IS_FROZEN:
        try:
            import secrets_bootstrap
            outcome = secrets_bootstrap.ensure_secrets(repo)
            tlog(f"secrets bootstrap: {outcome}")
        except Exception:
            tlog("secrets bootstrap error (continuing to the env-file path):\n"
                 + traceback.format_exc())

    # APPLY A STAGED UPDATE, if one is pending, BEFORE anything reads code or starts a child. The
    # engine's "Update now" only DOWNLOADS and stages a package; the swap lands here, at launch,
    # when no process holds the files (the safe moment on Windows). apply_pending keeps outputs/,
    # clients/ and server/.env, rolls back on any failure, and is a no-op when nothing is pending.
    if IS_FROZEN:
        try:
            spec = importlib.util.spec_from_file_location("app_update", repo / "app_update.py")
            app_update = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(app_update)
            applied = app_update.apply_pending(repo)
            if applied is not None:
                tlog(f"app update: {applied}")
        except Exception:
            tlog("app update apply error (continuing with the current version):\n"
                 + traceback.format_exc())

    try:
        launcher = load_launcher(repo)
    except Exception:
        tlog("failed to import launcher.py:\n" + traceback.format_exc())
        native_error("Strategi Canon could not load launcher.py from " + str(repo)
                     + ". Get a fresh copy of the Canon folder from your admin.")
        return 1

    import pystray  # after logging setup so a backend failure lands in tray.log

    tray = CanonTray(repo, launcher)

    icon = pystray.Icon(
        "strategi-canon",
        icon=dot_image(AMBER),
        title=APP_NAME,
        menu=pystray.Menu(tray.menu_items),
    )
    tray.icon = icon

    def setup(icon) -> None:
        icon.visible = True
        tray.boot()

    icon.run(setup=setup)  # blocks the main thread until Quit
    tray.stop_children()   # belt and braces if run() returns another way
    tlog("tray exited")
    return 0


if __name__ == "__main__":
    sys.exit(main())

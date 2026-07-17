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

def augment_path() -> None:
    """A macOS app launched from Finder inherits /usr/bin:/bin:/usr/sbin:/sbin,
    so node, npm, and claude installed by Homebrew or npm are invisible to
    shutil.which. Prepend the usual install locations that actually exist.
    Windows GUI apps inherit the system PATH the installers already updated."""
    if IS_WINDOWS:
        return
    home = Path.home()
    candidates = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        str(home / ".local" / "bin"),
        str(home / ".claude" / "local"),          # Claude Code local install
        str(home / ".npm-global" / "bin"),
        str(home / "n" / "bin"),
    ]
    current = os.environ.get("PATH", "").split(os.pathsep)
    added = [c for c in candidates if c not in current and Path(c).is_dir()]
    if added:
        os.environ["PATH"] = os.pathsep.join(added + current)
        tlog(f"PATH augmented with: {', '.join(added)}")


# ---------------------------------------------------------------------------
# Repo discovery
# ---------------------------------------------------------------------------

def looks_like_repo(p: Path) -> bool:
    return (p / "launcher.py").is_file() and (p / "server" / "app.py").is_file()


def discover_repo() -> Path | None:
    """(a) walk UP from the executable/frozen location and from this file,
    (b) the stored path in ~/.strategi-canon.json, (c) a tkinter folder picker
    persisted to (b). Returns None when all three fail; the caller shows a
    native-ish error and exits."""
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
    """Inside a PyInstaller app sys.executable is the app binary, so creating
    the engine's .venv needs a real interpreter from PATH. Returns None when
    none is found; only fatal if .venv does not already exist."""
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
    job = kernel32.CreateJobObjectW(None, None)
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))  # 9 = JobObjectExtendedLimitInformation
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
            job = _ensure_windows_job()
            PROCESS_SET_QUOTA, PROCESS_TERMINATE = 0x0100, 0x0001
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, proc.pid)
            if handle:
                ctypes.windll.kernel32.AssignProcessToJobObject(job, handle)
                ctypes.windll.kernel32.CloseHandle(handle)
        else:
            script = (
                f"while kill -0 {os.getpid()} 2>/dev/null; do sleep 2; done; "
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
# The app
# ---------------------------------------------------------------------------

class CanonTray:
    def __init__(self, repo: Path, launcher) -> None:
        self.repo = repo
        self.launcher = launcher
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
        yield Menu.SEPARATOR
        yield Item("Quit", self.on_quit)

    # -- preflight --------------------------------------------------------

    def run_preflight(self) -> list[dict]:
        checks = list(self.launcher.preflight_checks())
        checks.append(self.launcher.env_file_check())
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

    def on_restart(self, icon=None, item=None) -> None:
        def work():
            self._set_state("starting", "Restarting...")
            self.stop_children()
            self.startup()
        threading.Thread(target=work, name="canon-restart", daemon=True).start()

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
    augment_path()

    repo = discover_repo()
    if repo is None:
        native_error(
            "Strategi Canon could not find its folder (the one containing launcher.py). "
            "Put the app inside the Canon folder you got from your admin, or pick the "
            "folder when asked, then open the app again."
        )
        return 1

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

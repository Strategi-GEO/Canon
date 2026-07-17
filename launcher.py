#!/usr/bin/env python3
"""Strategi Canon launcher.

One file, double-clicked (via "Start Canon.command" on macOS or "Start Canon.bat"
on Windows), brings the whole product up locally:

  - the FastAPI engine on http://127.0.0.1:8000
  - the Next.js dashboard on http://localhost:3000
  - the browser opened to the dashboard

Pure Python standard library. No bash-isms: every OS difference goes through
sys.platform branches so the same file runs on macOS and Windows.

There is NO mock mode. Every generation is real: the engine spawns the `claude`
CLI using THIS device's Claude Code login, so every run spends real quota from
the device owner's own Claude subscription (unless ANTHROPIC_API_KEY is set, in
which case that key is billed instead).

Flags (all optional, for testing and unusual setups):
  --engine-port N     run the engine on port N instead of 8000
  --dashboard-port N  run the dashboard on port N instead of 3000
  --no-dashboard      start only the engine; skip npm install, next dev, and
                      the browser open (useful for engine-only smoke tests)
  --no-browser        do not open a browser tab when everything is up

Secrets policy: this launcher never prints a credential value and never writes
one to disk. Credentials lifted from ~/.claude.json go into the engine child
process environment only, never into this process's own os.environ.

Importable API (used by canon_app/tray.py, the menu-bar wrapper):
  This file doubles as a module. The tray app imports it and calls the
  raise-based cores, which raise LauncherError instead of exiting the process:
    preflight_checks() -> list[{"name","ok","problem","fix"}]
    env_file_check()   -> {"name","ok","problem","fix"}
    ensure_venv_raise(base_python=None) -> Path
    build_engine_env() -> dict
    reclaim_port_raise(port)
    ensure_dashboard_deps_raise()
    clear_next_cache()
    start_engine(py, env, port, stdout=None, stderr=None) -> Popen
    start_dashboard(port, stdout=None, stderr=None) -> Popen
    engine_health_url(port) -> str
    wait_for_http(url, proc, what, timeout_s) -> bool
    stop_process_tree(proc, what)
  The CLI wrappers (preflight, check_env_file, ensure_venv, reclaim_port,
  ensure_dashboard_deps) keep the original behavior: same log lines, and a
  failure still exits the process through die().
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
IS_WINDOWS = sys.platform.startswith("win")

# Credential names the engine needs for research fetches. Values are lifted
# from ~/.claude.json (the Claude Code CLI's own MCP server definitions) or
# taken from the environment the launcher was started in. Names only, here and
# in every log line: values are never printed.
RESEARCH_KEYS = ("FIRECRAWL_API_KEY", "DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD")
ENV_FILE_KEYS = ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY")


class LauncherError(Exception):
    """A launcher step failed. The raise-based cores raise this instead of
    exiting so an embedding app (the tray) can catch it and stay alive; the
    CLI wrappers translate it into die() so terminal behavior is unchanged."""


def log(msg: str) -> None:
    print(f"[canon] {msg}", flush=True)


def die(msg: str) -> None:
    log(f"FATAL: {msg}")
    sys.exit(1)


# ---------------------------------------------------------------------------
# a. PREFLIGHT
# ---------------------------------------------------------------------------

def which_any(*names: str) -> str | None:
    """First of `names` found on PATH, or None."""
    for name in names:
        path = shutil.which(name)
        if path:
            return path
    return None


def preflight_checks() -> list[dict]:
    """Structured preflight: one {name, ok, problem, fix} dict per check.

    `problem` and `fix` are empty strings when the check passes. The CLI
    prints them joined with a single space, which reproduces the original
    one-string messages byte for byte.
    """
    checks: list[dict] = []

    py_ok = sys.version_info >= (3, 11)
    checks.append({
        "name": "python",
        "ok": py_ok,
        "problem": "" if py_ok else (
            f"Python {sys.version_info.major}.{sys.version_info.minor} is too old. "
            "Strategi Canon needs Python 3.11 or newer."
        ),
        "fix": "" if py_ok else (
            "Install it from https://www.python.org/downloads/ and run this again."
        ),
    })

    node_ok = which_any("node", "node.exe") is not None
    checks.append({
        "name": "node",
        "ok": node_ok,
        "problem": "" if node_ok else (
            "Node.js is not on PATH. The dashboard cannot run without it."
        ),
        "fix": "" if node_ok else (
            "Install Node 20+ from https://nodejs.org/ (pick the LTS installer), "
            "then close and reopen this window so PATH refreshes."
        ),
    })

    npm_ok = which_any("npm", "npm.cmd") is not None
    checks.append({
        "name": "npm",
        "ok": npm_ok,
        "problem": "" if npm_ok else (
            "npm is not on PATH. It ships with Node.js, so this usually means the "
            "Node install did not finish or the window predates it."
        ),
        "fix": "" if npm_ok else (
            "Reinstall Node 20+ from https://nodejs.org/ and reopen this window."
        ),
    })

    claude_names = ("claude", "claude.cmd") if IS_WINDOWS else ("claude",)
    claude_ok = which_any(*claude_names) is not None
    checks.append({
        "name": "claude",
        "ok": claude_ok,
        "problem": "" if claude_ok else (
            "The `claude` CLI is not on PATH. The engine spawns it for every "
            "generation, and it is what ties runs to your own Claude subscription."
        ),
        "fix": "" if claude_ok else (
            "Install Claude Code (https://claude.com/claude-code), run `claude` once "
            "in a terminal to log in with YOUR account, then reopen this window."
        ),
    })

    return checks


def preflight() -> None:
    log("PREFLIGHT: checking this machine has everything Strategi Canon needs")
    problems = [c for c in preflight_checks() if not c["ok"]]
    if problems:
        for c in problems:
            log(f"PREFLIGHT MISS: {c['problem']} {c['fix']}")
        die(f"{len(problems)} preflight check(s) failed. Fix the item(s) above and double-click the starter again.")
    log("PREFLIGHT: ok (Python, node, npm, claude CLI all found)")


# ---------------------------------------------------------------------------
# b. VENV
# ---------------------------------------------------------------------------

def venv_python() -> Path:
    if IS_WINDOWS:
        return REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    return REPO_ROOT / ".venv" / "bin" / "python"


def ensure_venv_raise(base_python: str | None = None) -> Path:
    """Create .venv and install requirements if missing; return its python.

    `base_python` is the interpreter used to create the venv. It defaults to
    sys.executable, which is correct for the CLI; the tray app passes an
    explicit system python because inside a frozen (PyInstaller) app
    sys.executable is the app binary, not a Python interpreter.
    """
    py = venv_python()
    if py.exists():
        log("VENV: .venv already present, reusing it")
        return py

    log("VENV: .venv missing, creating it (one-time, takes a minute)")
    result = subprocess.run(
        [base_python or sys.executable, "-m", "venv", str(REPO_ROOT / ".venv")],
        cwd=str(REPO_ROOT),
    )
    if result.returncode != 0 or not py.exists():
        raise LauncherError(
            "could not create the Python virtual environment (.venv). "
            "Check that your Python install includes the `venv` module, "
            "then delete the .venv folder if one half-exists and retry."
        )

    log("VENV: installing Python dependencies from requirements.txt")
    result = subprocess.run(
        [str(py), "-m", "pip", "install", "-r", str(REPO_ROOT / "requirements.txt")],
        cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        raise LauncherError(
            "pip install failed. Check your internet connection, then delete the "
            ".venv folder and double-click the starter again for a clean retry."
        )
    log("VENV: dependencies installed")
    return py


def ensure_venv() -> Path:
    try:
        return ensure_venv_raise()
    except LauncherError as exc:
        die(str(exc))
        raise  # unreachable; die() exits


# ---------------------------------------------------------------------------
# c. ENV FILE
# ---------------------------------------------------------------------------

def env_file_check() -> dict:
    """Structured server/.env check: {name, ok, problem, fix}."""
    env_path = REPO_ROOT / "server" / ".env"
    if not env_path.exists():
        return {
            "name": "env-file",
            "ok": False,
            "problem": (
                "server/.env does not exist. This file holds the database and Supabase "
                "credentials and is NOT in the repo on purpose."
            ),
            "fix": "Ask the team admin for the server/.env file and place it at: " + str(env_path),
        }

    present: set[str] = set()
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if value.strip():
                present.add(key.strip())
    except OSError as exc:
        return {
            "name": "env-file",
            "ok": False,
            "problem": f"server/.env exists but could not be read ({exc}).",
            "fix": "Fix its permissions and retry.",
        }

    missing = [k for k in ENV_FILE_KEYS if k not in present]
    if missing:
        return {
            "name": "env-file",
            "ok": False,
            "problem": "server/.env is missing these required keys: " + ", ".join(missing) + ".",
            "fix": (
                "The team admin supplies this file complete; ask them for the "
                "current server/.env rather than editing it by hand."
            ),
        }
    return {"name": "env-file", "ok": True, "problem": "", "fix": ""}


def check_env_file() -> None:
    log("ENV FILE: checking server/.env")
    check = env_file_check()
    if not check["ok"]:
        die(f"{check['problem']} {check['fix']}")
    log("ENV FILE: ok (DATABASE_URL, SUPABASE_URL, SUPABASE_SECRET_KEY all present)")


# ---------------------------------------------------------------------------
# d. RESEARCH CREDS (ported from scripts/dev-serve.sh)
# ---------------------------------------------------------------------------

def collect_research_creds() -> dict[str, str]:
    """Lift Firecrawl and DataForSEO credentials out of ~/.claude.json.

    The Claude Code CLI keeps its own MCP server definitions there, env values
    included. Walk the whole file for mcpServers entries whose name contains
    "firecrawl" or "dataforseo" and collect their env blocks. Values are never
    printed and never written anywhere: they go into the engine subprocess env
    dict only.
    """
    path = Path.home() / ".claude.json"
    wanted = ("firecrawl", "dataforseo")
    found: dict[str, str] = {}

    def walk(node: object) -> None:
        if isinstance(node, dict):
            servers = node.get("mcpServers")
            if isinstance(servers, dict):
                for name, cfg in servers.items():
                    if not isinstance(cfg, dict):
                        continue
                    if any(w in str(name).lower() for w in wanted):
                        for key, value in (cfg.get("env") or {}).items():
                            if value:
                                found[str(key)] = str(value)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    try:
        with open(path, encoding="utf-8") as handle:
            walk(json.load(handle))
    except (OSError, json.JSONDecodeError):
        pass
    return found


def build_engine_env() -> dict[str, str]:
    log("RESEARCH CREDS: looking for Firecrawl and DataForSEO credentials in ~/.claude.json")
    env = dict(os.environ)  # subprocess env dict only; launcher's os.environ is never mutated

    lifted = collect_research_creds()
    for key, value in lifted.items():
        # A var already exported in the shell wins, matching server/db.py's rule
        # for deployments that inject config through the environment.
        env.setdefault(key, value)

    for key in RESEARCH_KEYS:
        state = "loaded" if env.get(key) else "MISSING"
        log(f"RESEARCH CREDS: {key} {state}")

    if not all(env.get(k) for k in RESEARCH_KEYS):
        log("RESEARCH CREDS: WARNING, one or more research credentials resolved nowhere.")
        log("RESEARCH CREDS: WARNING, research fetches WILL FAIL and blogs CANNOT be generated on this machine.")
        log("RESEARCH CREDS: WARNING, the dashboard still works for viewing existing runs and outputs.")
        log("RESEARCH CREDS: fix: get the Firecrawl and DataForSEO keys from the team admin, either")
        log("RESEARCH CREDS: fix: via Claude Code MCP setup (they land in ~/.claude.json) or exported")
        log("RESEARCH CREDS: fix: as FIRECRAWL_API_KEY, DATAFORSEO_USERNAME, DATAFORSEO_PASSWORD.")
    else:
        log("RESEARCH CREDS: ok (all research credentials resolved; values not shown)")
    return env


# ---------------------------------------------------------------------------
# e. BILLING BANNER
# ---------------------------------------------------------------------------

def billing_banner(engine_env: dict[str, str]) -> None:
    log("BILLING: Strategi Canon has NO mock mode. Every generation is real and spends real quota.")
    if not engine_env.get("ANTHROPIC_API_KEY"):
        log("BILLING: ANTHROPIC_API_KEY is not set, so runs will draw on THIS device's")
        log("BILLING: Claude Code subscription login. One blog is several agent sessions;")
        log("BILLING: a full batch can use a meaningful share of a personal plan's quota.")
    else:
        log("BILLING: ANTHROPIC_API_KEY is set; runs bill that API key, not a personal subscription.")


# ---------------------------------------------------------------------------
# f. PORTS
# ---------------------------------------------------------------------------

def pids_on_port(port: int) -> list[int]:
    pids: set[int] = set()
    if IS_WINDOWS:
        try:
            out = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True, text=True, timeout=30,
            ).stdout
        except (OSError, subprocess.TimeoutExpired):
            return []
        for line in out.splitlines():
            parts = line.split()
            # Proto  Local Address  Foreign Address  State  PID
            if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING":
                local = parts[1]
                if local.endswith(f":{port}"):
                    try:
                        pids.add(int(parts[4]))
                    except ValueError:
                        pass
    else:
        try:
            out = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}"],
                capture_output=True, text=True, timeout=30,
            ).stdout
        except (OSError, subprocess.TimeoutExpired):
            return []
        for token in out.split():
            try:
                pids.add(int(token))
            except ValueError:
                pass
    return sorted(pids)


def kill_pid(pid: int, force: bool) -> None:
    if IS_WINDOWS:
        cmd = ["taskkill", "/PID", str(pid), "/T"]
        if force:
            cmd.append("/F")
        subprocess.run(cmd, capture_output=True)
    else:
        try:
            os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass


def reclaim_port_raise(port: int) -> None:
    """A stale server holding a port is invisible until the new one fails to
    bind, so reclaim it up front rather than surfacing a confusing error."""
    pids = pids_on_port(port)
    if not pids:
        return
    log(f"PORTS: port {port} is held by pid(s) {', '.join(map(str, pids))}, stopping them")
    for pid in pids:
        kill_pid(pid, force=False)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and pids_on_port(port):
        time.sleep(0.5)
    for pid in pids_on_port(port):
        kill_pid(pid, force=True)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and pids_on_port(port):
        time.sleep(0.5)
    leftovers = pids_on_port(port)
    if leftovers:
        raise LauncherError(
            f"port {port} is still held by pid(s) {', '.join(map(str, leftovers))} "
            "after two stop attempts. Close whatever is using it (or reboot) and retry."
        )
    log(f"PORTS: port {port} reclaimed")


def reclaim_port(port: int) -> None:
    try:
        reclaim_port_raise(port)
    except LauncherError as exc:
        die(str(exc))


# ---------------------------------------------------------------------------
# g. DASHBOARD DEPS
# ---------------------------------------------------------------------------

def ensure_dashboard_deps_raise() -> None:
    dash = REPO_ROOT / "dashboard"
    if not dash.is_dir():
        raise LauncherError("the dashboard/ folder is missing. Re-clone the repo; this checkout is incomplete.")
    if (dash / "node_modules").is_dir():
        log("DASHBOARD DEPS: node_modules present, skipping npm install")
        return
    log("DASHBOARD DEPS: node_modules missing, running npm install (one-time, takes a few minutes)")
    if IS_WINDOWS:
        result = subprocess.run("npm install", cwd=str(dash), shell=True)
    else:
        result = subprocess.run(["npm", "install"], cwd=str(dash))
    if result.returncode != 0:
        raise LauncherError(
            "npm install failed in dashboard/. Check your internet connection, then "
            "delete dashboard/node_modules if it half-exists and retry."
        )
    log("DASHBOARD DEPS: installed")


def ensure_dashboard_deps() -> None:
    try:
        ensure_dashboard_deps_raise()
    except LauncherError as exc:
        die(str(exc))


def clear_next_cache() -> None:
    # Dev and production builds cannot share one .next: `next build`
    # overwrites the manifests `next dev` reads and dev then 500s on every
    # route. Rebuilding the cache from clean on each start costs seconds and
    # removes the most common way the app looks broken when nothing is wrong.
    next_cache = REPO_ROOT / "dashboard" / ".next"
    if next_cache.exists():
        log("DASHBOARD DEPS: clearing dashboard/.next dev cache (rebuilt automatically)")
        shutil.rmtree(next_cache, ignore_errors=True)


# ---------------------------------------------------------------------------
# h. START + wait
# ---------------------------------------------------------------------------

def spawn(cmd, cwd: Path, env: dict[str, str], use_shell_on_windows: bool = False,
          stdout=None, stderr=None) -> subprocess.Popen:
    """stdout/stderr default to None (inherit the console, the CLI shape).
    The tray app passes open log-file handles instead, because a windowed app
    has no console for the children to inherit."""
    if IS_WINDOWS:
        if use_shell_on_windows:
            # npm is npm.cmd on Windows; the shell resolves it.
            return subprocess.Popen(" ".join(cmd), cwd=str(cwd), env=env, shell=True,
                                    stdout=stdout, stderr=stderr)
        return subprocess.Popen(cmd, cwd=str(cwd), env=env, stdout=stdout, stderr=stderr)
    # Its own session (= its own process group), so one killpg later takes the
    # whole tree down: uvicorn's children, next dev's compiled workers, all of it.
    return subprocess.Popen(cmd, cwd=str(cwd), env=env, start_new_session=True,
                            stdout=stdout, stderr=stderr)


def engine_health_url(port: int) -> str:
    return f"http://127.0.0.1:{port}/api/health"


def start_engine(py: Path, env: dict[str, str], port: int,
                 stdout=None, stderr=None) -> subprocess.Popen:
    # One worker, always: the client lock and the topic semaphore are
    # in-process primitives in server/runner.py, so --workers N would
    # silently multiply the concurrency cap.
    log(f"START: engine on http://127.0.0.1:{port}")
    return spawn(
        [str(py), "-m", "uvicorn", "server.app:app",
         "--host", "127.0.0.1", "--port", str(port), "--workers", "1"],
        cwd=REPO_ROOT, env=env, stdout=stdout, stderr=stderr,
    )


def start_dashboard(port: int, stdout=None, stderr=None) -> subprocess.Popen:
    log(f"START: dashboard on http://localhost:{port}")
    dash_env = dict(os.environ)
    dash_env["PORT"] = str(port)  # next dev honors PORT
    return spawn(
        ["npm", "run", "dev"],
        cwd=REPO_ROOT / "dashboard", env=dash_env,
        use_shell_on_windows=True, stdout=stdout, stderr=stderr,
    )


def wait_for_http(url: str, proc: subprocess.Popen, what: str, timeout_s: int) -> bool:
    """Poll `url` until it answers 2xx/3xx, `proc` dies, or `timeout_s` passes."""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            log(f"START: {what} exited with code {proc.returncode} before it became reachable")
            return False
        try:
            with urllib.request.urlopen(url, timeout=4) as resp:
                if 200 <= resp.status < 400:
                    return True
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(1.0)
    log(f"START: gave up waiting for {what} at {url} after {timeout_s}s")
    return False


def stop_process_tree(proc: subprocess.Popen, what: str) -> None:
    if proc.poll() is not None:
        return
    log(f"LIFECYCLE: stopping {what} (pid {proc.pid})")
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if not IS_WINDOWS:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log(f"LIFECYCLE: {what} did not exit cleanly; it may need a manual kill")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        prog="launcher.py",
        description=(
            "Strategi Canon launcher: starts the FastAPI engine (default 127.0.0.1:8000) "
            "and the Next.js dashboard (default localhost:3000), then opens the browser. "
            "There is no mock mode; every generation is real and spends real quota from "
            "this device's Claude subscription (or ANTHROPIC_API_KEY if set)."
        ),
        epilog=(
            "The port and --no-* flags exist for testing and unusual setups, e.g. an "
            "engine-only smoke test on a spare port: "
            "launcher.py --no-dashboard --no-browser --engine-port 8901"
        ),
    )
    parser.add_argument("--engine-port", type=int, default=8000,
                        help="port for the FastAPI engine (default: 8000)")
    parser.add_argument("--dashboard-port", type=int, default=3000,
                        help="port for the Next.js dashboard (default: 3000)")
    parser.add_argument("--no-dashboard", action="store_true",
                        help="start only the engine: skip npm install, the dashboard process, and the browser open")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser tab once everything is up")
    args = parser.parse_args()

    log("Strategi Canon starting up")
    log(f"repo root: {REPO_ROOT}")

    # a-e: checks and environment
    preflight()
    py = ensure_venv()
    check_env_file()
    engine_env = build_engine_env()
    billing_banner(engine_env)

    # f: ports
    reclaim_port(args.engine_port)
    if not args.no_dashboard:
        reclaim_port(args.dashboard_port)

    # g: dashboard deps
    if not args.no_dashboard:
        ensure_dashboard_deps()
        clear_next_cache()

    engine_proc: subprocess.Popen | None = None
    dash_proc: subprocess.Popen | None = None
    exit_code = 0

    try:
        # h: start the engine.
        engine_proc = start_engine(py, engine_env, args.engine_port)
        health_url = engine_health_url(args.engine_port)
        if not wait_for_http(health_url, engine_proc, "engine", timeout_s=120):
            die("the engine never became healthy. Scroll up for its error output.")
        log(f"START: engine is healthy at {health_url}")

        # h: start the dashboard.
        if not args.no_dashboard:
            dash_proc = start_dashboard(args.dashboard_port)
            dash_url = f"http://localhost:{args.dashboard_port}/"
            if not wait_for_http(dash_url, dash_proc, "dashboard", timeout_s=180):
                die("the dashboard never became reachable. Scroll up for its error output.")
            log(f"START: dashboard is up at {dash_url}")

            if not args.no_browser:
                log(f"START: opening your browser at {dash_url}")
                webbrowser.open(dash_url)

            log("")
            log(f"  Dashboard   http://localhost:{args.dashboard_port}")
            log(f"  Engine      http://127.0.0.1:{args.engine_port}")
            log("")
            log("  Leave this window open while you work. Ctrl+C (or closing it) stops everything.")
            log("")
        else:
            log("START: --no-dashboard set, engine only")
            log(f"  Engine      http://127.0.0.1:{args.engine_port}")
            log("  Ctrl+C stops it.")

        # i: lifecycle. Stay in the foreground; if either child dies, report it
        # and take the other down too.
        while True:
            if engine_proc.poll() is not None:
                log(f"LIFECYCLE: the engine exited with code {engine_proc.returncode}")
                exit_code = engine_proc.returncode or 1
                break
            if dash_proc is not None and dash_proc.poll() is not None:
                log(f"LIFECYCLE: the dashboard exited with code {dash_proc.returncode}")
                exit_code = dash_proc.returncode or 1
                break
            time.sleep(0.5)

    except KeyboardInterrupt:
        log("LIFECYCLE: Ctrl+C received, shutting down")
        exit_code = 0
    finally:
        if dash_proc is not None:
            stop_process_tree(dash_proc, "dashboard")
        if engine_proc is not None:
            stop_process_tree(engine_proc, "engine")
        log("stopped.")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())

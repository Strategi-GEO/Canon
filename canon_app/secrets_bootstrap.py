"""Fetch the engine's secrets after an operator logs in, so nobody is handed a server/.env.

THE FALLBACK IS SACRED: this never removes the file-based path, it only adds a login-based one
in front of it. `ensure_secrets` writes an env ONLY when there is no usable one already and the
public config is filled in. A machine with a real server/.env (beside the app, or already
fetched) never sees a login prompt, so the working release keeps working untouched.

The flow, once bootstrap.json carries the project's PUBLIC url + anon key (the same pair the
website ships to browsers):
  1. operator signs in with their own Canon account (GoTrue password grant, anon apikey),
  2. the app calls get_engine_secrets() (migration 028), admin-gated server-side,
  3. the returned key/value pairs are written to <tree>/server/.env, which the engine reads
     exactly as it read the forwarded file.
Only the PUBLIC pair ships in the app; the secrets themselves never leave Supabase until an
admin has logged in.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

IS_MAC = sys.platform == "darwin"

# The engine refuses to start without these three (launcher.ENV_FILE_KEYS), so a provision that
# does not deliver them is a failure worth reporting, not a half-written file the engine chokes on.
REQUIRED_KEYS = ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY")


def _config_candidates() -> list[Path]:
    """Where bootstrap.json might be. In a PyInstaller build it is unpacked under _MEIPASS; from
    source it sits beside this file. Both are checked so the same code works frozen and in dev."""
    paths = []
    meipass = getattr(sys, "_MEIPASS", "")
    if meipass:
        paths.append(Path(meipass) / "bootstrap.json")
    paths.append(Path(__file__).resolve().parent / "bootstrap.json")
    return paths


class BootstrapError(Exception):
    """A login or fetch failure with a message fit to show the operator."""


def load_public_config(path: Path | None = None) -> dict:
    """The public {url, anon_key}, from bootstrap.json with env overrides on top. Env wins so CI
    can inject per-environment values without editing the committed file. Missing/garbled file
    is the empty (unconfigured) config, never a crash: unconfigured just means fall back."""
    candidates = [path] if path is not None else _config_candidates()
    data = {}
    for candidate in candidates:
        try:
            raw = json.loads(candidate.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data = raw
                break
        except (OSError, json.JSONDecodeError):
            continue
    url = (os.environ.get("CANON_SUPABASE_URL") or data.get("supabase_url") or "").strip().rstrip("/")
    anon = (os.environ.get("CANON_SUPABASE_ANON_KEY") or data.get("supabase_anon_key") or "").strip()
    return {"url": url, "anon_key": anon}


def is_configured(cfg: dict) -> bool:
    """Whether login-based provisioning is even possible. A blank pair, the shipped default,
    reads as 'not configured' so the app falls back to the file path with no prompt."""
    return cfg.get("url", "").startswith("http") and bool(cfg.get("anon_key"))


def _parse_env_keys(text: str) -> set[str]:
    present = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if value.strip():
            present.add(key.strip())
    return present


def has_usable_env(tree: Path) -> bool:
    """A server/.env that carries all three required keys. The exact test launcher.env_file_check
    makes, mirrored here so the app never prompts for a login it does not need."""
    env_path = Path(tree) / "server" / ".env"
    try:
        present = _parse_env_keys(env_path.read_text(encoding="utf-8"))
    except OSError:
        return False
    return all(k in present for k in REQUIRED_KEYS)


def password_login(url: str, anon_key: str, email: str, password: str) -> str:
    """Sign in via GoTrue's password grant and return the access token. Mirrors auth._gotrue_token
    but uses the PUBLIC anon key as apikey, because this runs before any secret is on the machine."""
    req = urllib.request.Request(
        f"{url}/auth/v1/token?grant_type=password",
        method="POST",
        data=json.dumps({"email": email, "password": password}).encode(),
    )
    req.add_header("apikey", anon_key)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401):
            raise BootstrapError("That email or password was not accepted.") from exc
        raise BootstrapError(f"Sign in failed (HTTP {exc.code}).") from exc
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise BootstrapError(f"Could not reach the sign-in server: {exc}") from exc
    token = body.get("access_token")
    if not token:
        raise BootstrapError("Sign in did not return a session.")
    return token


def fetch_engine_secrets(url: str, anon_key: str, access_token: str) -> dict:
    """Call get_engine_secrets() (migration 028) as the signed-in user. A non-admin is refused
    server-side; PostgREST surfaces that as a 4xx, which becomes a clear message here."""
    req = urllib.request.Request(
        f"{url}/rest/v1/rpc/get_engine_secrets",
        method="POST",
        data=b"{}",
    )
    req.add_header("apikey", anon_key)
    req.add_header("Authorization", f"Bearer {access_token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            secrets = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise BootstrapError(
                "Your account is signed in but is not an operator (admin), so it cannot fetch "
                "the engine keys. Ask an admin to grant your account, or use a server/.env file."
            ) from exc
        raise BootstrapError(f"Fetching the engine keys failed (HTTP {exc.code}).") from exc
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise BootstrapError(f"Could not fetch the engine keys: {exc}") from exc
    if not isinstance(secrets, dict) or not secrets:
        raise BootstrapError(
            "The engine keys have not been seeded in Supabase yet. Seed engine_secrets (see "
            "migration 028), then sign in again."
        )
    missing = [k for k in REQUIRED_KEYS if not secrets.get(k)]
    if missing:
        raise BootstrapError(
            "The engine keys in Supabase are incomplete, missing: " + ", ".join(missing) + "."
        )
    return secrets


def write_env(tree: Path, secrets: dict) -> Path:
    """Write the fetched secrets to <tree>/server/.env, 0600. One key per line, values verbatim,
    which is the exact shape db._load_cfg parses. Returns the path written."""
    env_path = Path(tree) / "server" / ".env"
    env_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={value}" for key, value in secrets.items() if value not in (None, "")]
    env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        env_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    return env_path


def provision(cfg: dict, tree: Path, email: str, password: str) -> None:
    """One login-then-fetch-then-write. Raises BootstrapError with an operator-facing message on
    any failure, so the dialog can show it and let them retry."""
    token = password_login(cfg["url"], cfg["anon_key"], email, password)
    secrets = fetch_engine_secrets(cfg["url"], cfg["anon_key"], token)
    write_env(tree, secrets)


def _osascript(script: str) -> tuple[int, str]:
    """Run one AppleScript, returning (exit code, stdout with the trailing newline stripped). A
    cancelled dialog exits non-zero (osascript maps Cancel/Esc to error -128)."""
    try:
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
    except Exception:
        return 1, ""
    return r.returncode, r.stdout.rstrip("\n")


def _as_str(s: str) -> str:
    """Quote s as an AppleScript string literal: escape backslash and double-quote, flatten
    newlines/tabs to spaces (AppleScript literals do not decode \\n), and pass UTF-8 through
    (osascript -e reads UTF-8). json.dumps would \\uXXXX-escape non-ASCII, which AppleScript
    cannot decode, so a localized OS/TLS error in a message would make the script fail to compile
    and its dialog never show."""
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    for ws in ("\n", "\r", "\t"):
        s = s.replace(ws, " ")
    return '"' + s + '"'


def _mac_ask(prompt: str, hidden: bool = False, default: str = "") -> str | None:
    """One text field via osascript. Returns the entered text (raw, unstripped so a password keeps
    every character) or None when the operator cancelled. `default` pre-fills the field, so a
    failed attempt can re-show the email already typed."""
    script = ("display dialog " + _as_str(prompt) + " default answer " + _as_str(default)
              + ' with title "Strategi Canon"')
    if hidden:
        script += " with hidden answer"
    code, out = _osascript(script)
    if code != 0:
        return None
    marker = "text returned:"           # osascript emits "button returned:OK, text returned:VALUE"
    i = out.find(marker)                # VALUE is the last field, so everything after it is the value
    return out[i + len(marker):] if i >= 0 else ""


def _mac_notify(message: str) -> None:
    _osascript("display dialog " + _as_str(message) +
               ' with title "Strategi Canon" buttons {"OK"} default button "OK" with icon caution')


def _prompt_login_mac(cfg: dict, tree: Path) -> bool:
    """The macOS sign-in, via osascript rather than Tk. Tkinter cannot coexist with pystray's
    NSApplication in one process: initialising Tk installs TKApplication as the shared NSApp, and
    the next menu validation panics (Tcl_Panic -> SIGABRT), which is exactly what crashed the app
    after a sign-in. osascript spawns a separate process, so nothing touches this app's NSApp."""
    email = ""
    while True:
        email = _mac_ask("Sign in to Strategi Canon with your Canon account. Email:", default=email)
        if email is None:
            return False
        email = email.strip()
        password = _mac_ask("Password:", hidden=True)
        if password is None:
            return False
        try:
            provision(cfg, tree, email, password)
            return True
        except Exception as exc:  # noqa: BLE001
            # Parity with the Tk path, whose Tkinter callback swallowed EVERY exception and kept
            # the dialog open: catch all (not just BootstrapError), so a write_env OSError or a
            # truncated-read HTTPException still loops for a retry rather than escaping into
            # ensure_secrets, which must NEVER raise. The operator can always Cancel to stop.
            _mac_notify(str(exc))


def prompt_login(cfg: dict, tree: Path) -> bool:
    """Loops a sign-in until the operator provisions or cancels. Returns True once server/.env is
    written, False if they cancelled or no UI is available (headless), in which case the caller
    falls back to its 'no env' state exactly as before. macOS uses osascript (see _prompt_login_mac
    for why Tk crashes there); every other platform keeps the Tk dialog."""
    if IS_MAC:
        return _prompt_login_mac(cfg, tree)
    try:
        import tkinter as tk
        from tkinter import ttk
    except Exception:
        return False

    state = {"done": False}

    root = tk.Tk()
    root.title("Sign in to Strategi Canon")
    root.attributes("-topmost", True)
    frm = ttk.Frame(root, padding=16)
    frm.grid()
    ttk.Label(frm, text="Sign in with your Canon account to set up this machine.").grid(
        column=0, row=0, columnspan=2, pady=(0, 10))
    ttk.Label(frm, text="Email").grid(column=0, row=1, sticky="w")
    email_var = tk.StringVar()
    ttk.Entry(frm, textvariable=email_var, width=32).grid(column=1, row=1, pady=2)
    ttk.Label(frm, text="Password").grid(column=0, row=2, sticky="w")
    pw_var = tk.StringVar()
    ttk.Entry(frm, textvariable=pw_var, show="•", width=32).grid(column=1, row=2, pady=2)
    error_var = tk.StringVar()
    ttk.Label(frm, textvariable=error_var, foreground="#b00020", wraplength=280).grid(
        column=0, row=3, columnspan=2, pady=(6, 0))
    busy_var = tk.StringVar()
    ttk.Label(frm, textvariable=busy_var).grid(column=0, row=4, columnspan=2)

    def attempt():
        error_var.set("")
        busy_var.set("Signing in...")
        root.update_idletasks()
        try:
            provision(cfg, tree, email_var.get().strip(), pw_var.get())
            state["done"] = True
            root.destroy()
        except BootstrapError as exc:
            busy_var.set("")
            error_var.set(str(exc))

    btns = ttk.Frame(frm)
    btns.grid(column=0, row=5, columnspan=2, pady=(12, 0))
    ttk.Button(btns, text="Cancel", command=root.destroy).grid(column=0, row=0, padx=4)
    ttk.Button(btns, text="Sign in", command=attempt).grid(column=1, row=0, padx=4)
    root.bind("<Return>", lambda _event: attempt())
    root.mainloop()
    return state["done"]


def ensure_secrets(tree: Path, cfg: dict | None = None) -> str:
    """The orchestrator the tray calls. Returns one of:
      'present'      an env already exists, nothing done (the common, working-release path),
      'unconfigured' no env and bootstrap.json is blank, so the caller keeps its file-based flow,
      'provisioned'  the operator signed in and server/.env was written,
      'cancelled'    a login was offered and declined (or headless), caller shows its no-env state.
    It NEVER raises: a failed login leaves the operator in the same no-env state they were in."""
    tree = Path(tree)
    if has_usable_env(tree):
        return "present"
    cfg = cfg or load_public_config()
    if not is_configured(cfg):
        return "unconfigured"
    return "provisioned" if prompt_login(cfg, tree) else "cancelled"

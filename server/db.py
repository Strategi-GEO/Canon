"""Supabase data access for the GEO factory server.

This module is the ONLY place the server touches Postgres or Storage, and the
ONLY place the Supabase credentials exist. Read the two rules before adding
anything:

RULE 1: CREDENTIALS NEVER ENTER os.environ.
    server/.env is parsed into the module-private _CFG dict below and nowhere
    else. Five modules hand a child environment to the Claude CLI subprocess
    (runner, describe, facts, facts_gen, roadmap_gen), those sessions run under
    acceptEdits with Bash, and an allowed_tools list is a skip-the-prompt list,
    not a sandbox. An env var that exists in this process is an env var an agent
    can read. So the credentials live in a Python dict the child env is not
    built from, and agent_env() below is the only legal way to build a child
    env. tests/env_check.py plants a canary secret and fails the build if either
    half of this regresses.

RULE 2: THE DATABASE IS THE RECORD, THE DISK IS SCRATCH.
    Every durable read and write goes through here. Local files exist only
    where a Claude agent subprocess physically needs them (it runs gates.py and
    the Edit tool against real paths), they are materialized FROM here at run
    start, and whatever they accumulate is committed BACK here by the runner.
    Nothing outside a run's working directory is ever read from disk again.

Sync model: psycopg sync pool. Async callers (runner, most routes) wrap calls
in asyncio.to_thread; sync callers call directly. At six operators and one
uvicorn worker a thread hop per query is invisible, and a sync pool keeps every
DAL function callable from the CLI and the tests without an event loop.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import threading
import urllib.error
import urllib.request

SERVER_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SERVER_DIR.parent

# ---------------------------------------------------------------------------
# Credentials: module-private, never exported
# ---------------------------------------------------------------------------
_CFG: dict[str, str] = {}
_CFG_LOCK = threading.Lock()

# The credentials this module OWNS. They are named once, because two places need
# the list and they must never drift: _load_cfg lets an exported one win, and
# config_value refuses to hand any of them to a caller outside this module.
_OWN_CREDENTIALS = ("SUPABASE_URL", "SUPABASE_SECRET_KEY", "DATABASE_URL")


def _load_cfg() -> dict[str, str]:
    """Parse server/.env once, into _CFG, and NEVER into os.environ."""
    with _CFG_LOCK:
        if _CFG:
            return _CFG
        envfile = SERVER_DIR / ".env"
        if envfile.is_file():
            for line in envfile.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                _CFG[key.strip()] = value.strip()
        # A var already exported in the shell wins, so deployments that inject
        # config through the environment keep working. This widens exposure
        # (an exported var is visible process-wide), which is exactly why
        # agent_env() is an allowlist and not a denylist.
        for key in _OWN_CREDENTIALS:
            if os.environ.get(key):
                _CFG[key] = os.environ[key]
        return _CFG


def db_configured() -> bool:
    return bool(_load_cfg().get("DATABASE_URL"))


def config_value(name: str) -> str:
    """One value out of the parsed server/.env, for a credential this module does
    not own. Returns "" when the file does not carry it.

    server/.env is the only credential file a teammate is ever handed, install.sh
    is the only thing that prompts for one, and the tray app reads it on every
    launch path. So a credential belonging to another module still has to be
    readable from here, or it has nowhere to live that works everywhere. The CMS
    write keys are the case that forced this accessor into existence: they are
    per-org, they are not the engine's own credentials, and before this a key
    placed in the obvious file was parsed into _CFG and then consulted by nobody,
    failing exactly as though it had never been written.

    RULE 1 SURVIVES INTACT, and routing the read through here rather than through
    os.environ is the whole reason it does. Nothing is exported. A value returned
    from this dict never enters os.environ, so agent_env() cannot carry it into a
    Claude session whatever its allowlist says: that allowlist filters os.environ,
    and this value was never in os.environ to be filtered. A secret kept in
    server/.env is therefore LESS exposed to an agent session than the same
    secret exported in a shell, not more.

    The three Supabase values are refused by name. They are this module's own
    credentials, nothing outside it has any business reading them, and a general
    accessor that would hand them over is a laundering route out of the private
    dict rather than a config reader.
    """
    if name in _OWN_CREDENTIALS:
        raise ValueError(
            f"{name} belongs to server/db.py and is not readable from outside it")
    return (_load_cfg().get(name) or "").strip()


# ---------------------------------------------------------------------------
# The child environment for agent subprocesses: ALLOWLIST, the only legal door
# ---------------------------------------------------------------------------
# A denylist is correct until someone adds SUPABASE_DB_PASSWORD or PGPASSWORD,
# and then it is a hole nobody edited into existence. Everything an agent
# session legitimately needs is named here; nothing else crosses.
#
# THE CMS WRITE KEYS (STRATEGI_CMS_WRITE_KEY_<ORG>) ARE DELIBERATELY ABSENT, and
# the omission is load-bearing rather than an oversight nobody got to. A write
# key files a draft straight into a client's live CMS, so it is a publishing
# credential, and no research or drafting session has any use for one: the push
# runs in THIS process, in server/cms/, long after every agent has exited. Naming
# the prefix here would hand every agent session the ability to write to a
# client's site and buy nothing at all in return. The keys reach
# server/cms/client.py either through os.environ in this process or through
# config_value() above, and neither route needs a line on this list.
AGENT_ENV_ALLOW = (
    # Process basics
    "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM",
    "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "CLAUDE_CONFIG_DIR",
    # The model
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    # The two sanctioned research tools (.mcp.json interpolates these)
    "FIRECRAWL_API_KEY", "FIRECRAWL_API_URL",
    "DATAFORSEO_USERNAME", "DATAFORSEO_PASSWORD",
    "FIRECRAWL_MCP_URL", "DATAFORSEO_MCP_URL",
    "FIRECRAWL_MCP_AUTH", "DATAFORSEO_MCP_AUTH",
    # Engine knobs
    "GEO_MODEL", "GEO_MAX_TURNS", "GEO_MAX_BUDGET_USD",
    "GEO_RETRIES", "GEO_DASHBOARD_ORIGINS",
)


def _venv_bin_dir() -> pathlib.Path | None:
    """The running venv's bin/Scripts dir, or None outside a venv."""
    import sys
    if sys.prefix == sys.base_prefix:
        return None
    d = pathlib.Path(sys.prefix) / ("Scripts" if sys.platform.startswith("win") else "bin")
    return d if d.is_dir() else None


def agent_env() -> dict[str, str]:
    """The child env for every Claude CLI subprocess: the allowlist, never the
    whole environment. tests/env_check.py bans the copy-everything idiom.

    The venv's bin/Scripts dir is prepended to PATH so `python3` in an agent
    session resolves to THIS engine's interpreter, the one that has the skill
    dependencies (bs4, jinja2, playwright) installed. Every prompt, skill, and
    CLAUDE.md itself says `python3`; a Windows venv ships only python.exe, so a
    python3.exe copy is planted beside it once, which is cheaper than teaching
    every prompt a second interpreter name."""
    env = {k: v for k, v in os.environ.items() if k in AGENT_ENV_ALLOW}
    venv_bin = _venv_bin_dir()
    if venv_bin is not None:
        import sys
        if sys.platform.startswith("win"):
            py3 = venv_bin / "python3.exe"
            if not py3.exists():
                try:
                    import shutil
                    shutil.copy2(venv_bin / "python.exe", py3)
                except OSError:
                    pass  # read-only venv: python3 stays unresolvable, sessions report it
        path = env.get("PATH", "")
        if str(venv_bin) not in path.split(os.pathsep):
            env["PATH"] = str(venv_bin) + os.pathsep + path
    return env


# ---------------------------------------------------------------------------
# Pool
# ---------------------------------------------------------------------------
_POOL = None
_POOL_LOCK = threading.Lock()


def pool():
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            from psycopg_pool import ConnectionPool
            dsn = _load_cfg().get("DATABASE_URL")
            if not dsn:
                raise RuntimeError(
                    "DATABASE_URL is not set in server/.env; the engine cannot "
                    "reach its store. Nothing falls back to disk: a silent disk "
                    "fallback is how two sources of truth are born.")
            _POOL = ConnectionPool(dsn, min_size=1, max_size=5, open=True,
                                   kwargs={"autocommit": True})
            import atexit
            atexit.register(close_pool)
        return _POOL


def close_pool():
    global _POOL
    with _POOL_LOCK:
        if _POOL is not None:
            try:
                _POOL.close()
            except Exception:
                pass
            _POOL = None


def q(sql: str, params=None, fetch: str = "all"):
    """Run one statement. fetch: 'all' | 'one' | 'val' | 'none'."""
    with pool().connection() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        if fetch == "none" or cur.description is None:
            return cur.rowcount
        if fetch == "one":
            return cur.fetchone()
        if fetch == "val":
            row = cur.fetchone()
            return row[0] if row else None
        return cur.fetchall()


def tx():
    """A transaction-scoped connection: `with db.tx() as cur:`."""
    return _Tx()


class _Tx:
    def __enter__(self):
        self._ctx = pool().connection()
        self._conn = self._ctx.__enter__()
        self._conn.autocommit = False
        self._cur = self._conn.cursor()
        return self._cur

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._cur.close()
            self._conn.autocommit = True
            self._ctx.__exit__(exc_type, exc, tb)


# ---------------------------------------------------------------------------
# Slug -> id cache. Six clients; invalidated on any client create/delete.
# ---------------------------------------------------------------------------
_CLIENT_IDS: dict[str, str] = {}
_IDS_LOCK = threading.Lock()


def client_id(slug: str) -> str | None:
    with _IDS_LOCK:
        if slug in _CLIENT_IDS:
            return _CLIENT_IDS[slug]
    row = q("select id from clients where slug = %s and deleted_at is null",
            (slug,), fetch="one")
    if not row:
        return None
    with _IDS_LOCK:
        _CLIENT_IDS[slug] = str(row[0])
    return str(row[0])


def invalidate_client_cache():
    with _IDS_LOCK:
        _CLIENT_IDS.clear()


def topic_id(client_slug: str, topic_slug: str) -> str | None:
    cid = client_id(client_slug)
    if not cid:
        return None
    return q("select id from topics where client_id = %s and slug = %s "
             "and deleted_at is null", (cid, topic_slug), fetch="val")


def ensure_topic(client_slug: str, topic_slug: str, title: str | None = None) -> str:
    cid = client_id(client_slug)
    if not cid:
        raise LookupError(f"unknown client {client_slug!r}")
    row = q("""insert into topics (client_id, slug, title) values (%s, %s, %s)
               on conflict (client_id, slug) do update
                 set deleted_at = null,
                     title = coalesce(excluded.title, topics.title)
               returning id""", (cid, topic_slug, title), fetch="val")
    return str(row)


# ---------------------------------------------------------------------------
# Storage (Resources): private bucket, secret key, sha256-addressed
# ---------------------------------------------------------------------------
RESOURCE_BUCKET = "resources"


class DuplicateResource(Exception):
    """A resource with this filename already exists for this client.

    Its own class rather than a RuntimeError because the route has to tell it
    apart from a storage failure: one is the caller's mistake and answers 409,
    the other is our infrastructure falling over and answers 502. storage_put
    and storage_get both raise RuntimeError, so reusing RuntimeError here would
    force the route to sniff the message text to decide which HTTP status the
    operator sees.
    """


def _storage(method: str, path: str, data: bytes | None = None,
             ctype: str = "application/octet-stream"):
    cfg = _load_cfg()
    req = urllib.request.Request(f"{cfg['SUPABASE_URL']}{path}", method=method,
                                 data=data)
    req.add_header("Authorization", f"Bearer {cfg['SUPABASE_SECRET_KEY']}")
    req.add_header("apikey", cfg["SUPABASE_SECRET_KEY"])
    if data is not None:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def storage_put(object_path: str, raw: bytes) -> None:
    status, body = _storage(
        "POST", f"/storage/v1/object/{RESOURCE_BUCKET}/{object_path}", raw)
    if status in (200, 201):
        return
    if status == 409 or b"Duplicate" in body or b"already exists" in body:
        return  # content-addressed: an existing object at this sha IS this file
    raise RuntimeError(f"storage put {object_path}: HTTP {status} {body[:200]!r}")


def storage_get(object_path: str) -> bytes:
    status, body = _storage(
        "GET", f"/storage/v1/object/{RESOURCE_BUCKET}/{object_path}")
    if status != 200:
        raise RuntimeError(f"storage get {object_path}: HTTP {status}")
    return body


def resource_add(client_slug: str, name: str, raw: bytes,
                 content_type: str | None = None) -> None:
    """Index one uploaded resource. A filename already in use is REFUSED.

    This used to upsert on (client_id, name), which meant a second upload of
    the same filename silently repointed object_path at different bytes and
    still answered 201, so the client believed they had added a file when they
    had in fact replaced one. Resources are the knowledge base every run reads,
    so a silent replacement quietly changes what future blogs are written from.
    Soon the only uploader is the CLIENT, through a hosted path with no
    operator watching the request, which is why the refusal is being put in now
    rather than after that path exists: an overwrite nobody sees is worse than
    an overwrite an admin at least performed deliberately. Replacing a file is
    delete then upload, two explicit acts.

    The check runs BEFORE storage_put so a rejected upload leaves no orphaned
    object behind. It is a read-then-write and not a constraint, so two uploads
    of the same name racing each other can both pass the check; the unique
    index on (client_id, name) is what actually stops the second one, and it
    surfaces as a 500 rather than a 409. That race needs two uploads of one
    filename within milliseconds of each other and it fails CLOSED, which is
    the acceptable direction here.
    """
    cid = client_id(client_slug)
    if q("select 1 from client_resources where client_id = %s and name = %s",
         (cid, name), fetch="val"):
        raise DuplicateResource(name)
    sha = hashlib.sha256(raw).hexdigest()
    storage_put(f"{client_slug}/{sha}", raw)
    q("""insert into client_resources
           (client_id, name, object_path, sha256, size_bytes, content_type)
         values (%s, %s, %s, %s, %s, %s)""",
      (cid, name, f"{RESOURCE_BUCKET}/{client_slug}/{sha}", sha, len(raw),
       content_type), fetch="none")


def resource_list(client_slug: str):
    cid = client_id(client_slug)
    if not cid:
        return []
    return q("""select name, sha256, size_bytes, object_path, content_type
                from client_resources where client_id = %s
                order by lower(name)""", (cid,))


def resource_delete(client_slug: str, name: str) -> bool:
    cid = client_id(client_slug)
    n = q("delete from client_resources where client_id = %s and name = %s",
          (cid, name), fetch="none")
    return bool(n)

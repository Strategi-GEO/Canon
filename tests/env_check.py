#!/usr/bin/env python3
"""The credential canary: no Supabase secret may ever reach an agent session.

Every Claude SDK session this server spawns runs Bash under acceptEdits, and an
allowed_tools list is a skip-the-prompt list, not a sandbox. An env var that
exists in the child environment is an env var an agent can read and exfiltrate
through a fetch or a blog draft. The defense is two independent layers, and this
script fails the build if either regresses:

  LAYER 1: server/db.py parses server/.env into a module-private dict and never
           writes a credential into os.environ.
  LAYER 2: db.agent_env() is an ALLOWLIST, and it is the only way any module
           builds a child environment. env=dict(os.environ) is banned.

Spawns nothing and calls no model, like every check in this directory.
Run: .venv/bin/python tests/env_check.py
"""

import os
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

FAILURES = []
CHECKS = 0


def check(name, ok, detail=""):
    global CHECKS
    CHECKS += 1
    if ok:
        print(f"  ok  {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL  {name}{': ' + detail if detail else ''}")


# --- Layer 2, static: the banned idiom stays banned -------------------------
hits = []
for py in (REPO / "server").rglob("*.py"):
    text = py.read_text(encoding="utf-8")
    for i, line in enumerate(text.splitlines(), 1):
        if "dict(os.environ)" in line and not line.lstrip().startswith("#"):
            hits.append(f"{py.relative_to(REPO)}:{i}")
check("no server module builds a child env from dict(os.environ)",
      not hits, "; ".join(hits))

spawn_hits = []
for py in (REPO / "server").rglob("*.py"):
    text = py.read_text(encoding="utf-8")
    for m in re.finditer(r"create_subprocess_exec\([^)]*\)", text, re.S):
        if "env=" not in m.group(0):
            spawn_hits.append(str(py.relative_to(REPO)))
check("every create_subprocess_exec passes an explicit env",
      not spawn_hits, "; ".join(spawn_hits))

# --- Plant the canary, then exercise both layers ----------------------------
CANARIES = {
    "SUPABASE_SECRET_KEY": "sb_secret_canary_do_not_leak",
    "SUPABASE_URL": "https://canary.supabase.co",
    "DATABASE_URL": "postgresql://canary:canary@127.0.0.1:5432/canary",
    "PGPASSWORD": "canary-pgpassword",
    "SUPABASE_DB_PASSWORD": "canary-db-password",
}
saved = {k: os.environ.get(k) for k in CANARIES}
os.environ.update(CANARIES)
try:
    from server import db

    env = db.agent_env()
    leaked = [k for k in CANARIES if k in env]
    check("agent_env() drops every planted credential", not leaked,
          ", ".join(leaked))

    suspicious = [k for k in env
                  if any(t in k.upper() for t in
                         ("SUPABASE", "POSTGRES", "DATABASE", "_DSN", "PGPASS",
                          "SECRET_KEY"))]
    check("agent_env() carries nothing credential-shaped", not suspicious,
          ", ".join(suspicious))

    keep = [k for k in ("PATH", "HOME") if k in os.environ]
    kept = [k for k in keep if k in env]
    check("agent_env() still carries the basics a CLI needs (PATH, HOME)",
          kept == keep, f"kept {kept} of {keep}")

    # Layer 1: loading config must not write credentials into os.environ.
    # _load_cfg READS the environment (an exported var wins over .env), but the
    # dict it builds is private; nothing may flow back out.
    before = dict(os.environ)
    db._load_cfg()
    new_keys = set(os.environ) - set(before)
    changed = {k for k in before if os.environ.get(k) != before[k]}
    check("_load_cfg() writes nothing into os.environ",
          not new_keys and not changed,
          f"new={sorted(new_keys)} changed={sorted(changed)}")

    # The five ClaudeAgentOptions builders all route through agent_env: assert
    # at the source level so a sixth spawn site cannot appear un-allowlisted.
    door_files = ["server/runner.py", "server/describe.py",
                  "server/facts_gen.py", "server/roadmap_gen.py"]
    undoored = []
    for f in door_files:
        text = (REPO / f).read_text(encoding="utf-8")
        if "ClaudeAgentOptions" in text and "db.agent_env()" not in text:
            undoored.append(f)
    check("every ClaudeAgentOptions builder uses db.agent_env()",
          not undoored, "; ".join(undoored))
finally:
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

print()
if FAILURES:
    print(f"{len(FAILURES)}/{CHECKS} checks FAILED")
    sys.exit(1)
print(f"ALL {CHECKS} CHECKS PASSED")

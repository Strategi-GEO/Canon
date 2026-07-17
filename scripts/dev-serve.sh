#!/usr/bin/env bash
# Local dev launcher for real mode.
#
# Why this exists: .mcp.json declares the firecrawl and dataforseo servers with
# ${VAR} placeholders so no secret is ever committed. Those placeholders expand
# from the process environment, and a plain "uvicorn server.app:app" inherits a
# shell that usually has none of them set. The MCP servers then fail to
# authenticate, and an agent with no Firecrawl cannot cite a source.
#
# On a developer machine the same credentials already sit in ~/.claude.json,
# where the Claude Code CLI keeps its own MCP server definitions. This script
# lifts them into the environment for the server process only. It never prints
# them and never writes them to a file.
#
# A SHARED DEPLOYMENT MUST NOT USE THIS. Set real environment variables there,
# and set ANTHROPIC_API_KEY too: without it the SDK spawns a CLI that bills a
# personal Claude subscription, and six operators will exhaust it.
#
# Usage:
#   scripts/dev-serve.sh              real mode on port 8000
#   scripts/dev-serve.sh 8080         real mode on port 8080
#   GEO_MOCK=1 scripts/dev-serve.sh   mock mode, no credentials needed
set -euo pipefail

PORT="${1:-8000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ "${GEO_MOCK:-}" != "1" ]; then
  # Read the CLI's own MCP env blocks. eval of a python-emitted export list keeps
  # the values out of argv, where ps would expose them to any user on the box.
  CREDS="$(python3 - <<'PY'
import json, os, shlex

path = os.path.expanduser("~/.claude.json")
wanted = ("firecrawl", "dataforseo")
found = {}

def walk(node):
    if isinstance(node, dict):
        servers = node.get("mcpServers")
        if isinstance(servers, dict):
            for name, cfg in servers.items():
                if any(w in name.lower() for w in wanted):
                    for key, value in (cfg.get("env") or {}).items():
                        if value:
                            found[key] = value
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for item in node:
            walk(item)

try:
    with open(path) as handle:
        walk(json.load(handle))
except (OSError, json.JSONDecodeError):
    pass

for key, value in found.items():
    print(f"export {key}={shlex.quote(value)}")
PY
)"
  if [ -z "$CREDS" ]; then
    echo "[dev-serve] no firecrawl or dataforseo credentials found in ~/.claude.json." >&2
    echo "[dev-serve] export FIRECRAWL_API_KEY, DATAFORSEO_USERNAME and DATAFORSEO_PASSWORD" >&2
    echo "[dev-serve] yourself, or run with GEO_MOCK=1 to skip real mode entirely." >&2
    exit 2
  fi
  eval "$CREDS"

  # Report which names resolved, never their values.
  for var in FIRECRAWL_API_KEY DATAFORSEO_USERNAME DATAFORSEO_PASSWORD; do
    if [ -n "${!var:-}" ]; then echo "[dev-serve] $var loaded"; else echo "[dev-serve] $var MISSING"; fi
  done

  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "[dev-serve] ANTHROPIC_API_KEY is not set: the SDK will spawn a CLI that draws on" >&2
    echo "[dev-serve] your personal Claude subscription quota. One blog is 3 to 5 agent" >&2
    echo "[dev-serve] sessions, so a full batch can exhaust it." >&2
  fi
  echo "[dev-serve] REAL MODE. Non-demo clients will spend credits."
else
  echo "[dev-serve] GEO_MOCK=1: mock mode, no credentials used."
fi

# One worker, always: the client lock and the 5-topic semaphore are in-process
# primitives in runner.py, so --workers N silently raises the cap to 5N.
exec .venv/bin/uvicorn server.app:app --host 127.0.0.1 --port "$PORT" --workers 1

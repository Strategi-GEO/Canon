#!/usr/bin/env bash
# Start the GEO Factory: the engine API and the dashboard, together.
#
#   ./run.sh          SAFE mode. Every client is mock. Nothing spends credits.
#   ./run.sh --real   REAL mode. Non-demo clients run the full agent chain and
#                     spend your Claude subscription quota.
#
# Ctrl+C stops both. Closing the terminal stops both, so a real run must be left
# alone in its own window until it finishes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

REAL=0
[ "${1:-}" = "--real" ] && REAL=1

# Dev and production builds cannot share one .next: `next build` overwrites the
# manifests `next dev` reads, and dev then 500s on every route with ENOENT on
# app-build-manifest.json. It does not recover on its own, so the cache is
# rebuilt from clean on every start. It costs a few seconds and removes the
# single most common way this app appears broken when nothing is wrong.
rm -rf dashboard/.next

# A stale server holding a port is invisible until the new one fails to bind, so
# reclaim both ports before starting rather than reporting a confusing error.
for port in 8000 3000; do
  pid="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    echo "[run] port $port was held by pid $pid, stopping it"
    kill $pid 2>/dev/null || true
    sleep 1
    kill -9 $pid 2>/dev/null || true
  fi
done

# Both children die with this script, including on Ctrl+C and on a closed window.
# Without this the API survives as an orphan still holding 8000, and the next
# start silently talks to yesterday's code.
API_PID=""
DASH_PID=""
cleanup() {
  trap - INT TERM EXIT
  [ -n "$DASH_PID" ] && kill "$DASH_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  echo ""
  echo "[run] stopped."
}
trap cleanup INT TERM EXIT

if [ "$REAL" = "1" ]; then
  echo "[run] REAL MODE. Non-demo clients will spend your Claude quota."
  # dev-serve.sh lifts Firecrawl and DataForSEO credentials out of ~/.claude.json
  # into the process environment. Without them an agent cannot fetch a source,
  # and a blog with no sources cannot pass its own gates.
  ./scripts/dev-serve.sh 8000 &
  API_PID=$!
else
  echo "[run] SAFE MODE (GEO_MOCK=1). Every client is mock. No credits, no API calls."
  echo "[run] Run './run.sh --real' when you actually want blogs written."
  GEO_MOCK=1 .venv/bin/uvicorn server.app:app --host 127.0.0.1 --port 8000 --workers 1 &
  API_PID=$!
fi

# The dashboard's first request fails outright if the engine is not listening
# yet, and it surfaces as "Cannot reach the engine", which reads like a bug
# rather than a race. Waiting here keeps the first paint honest.
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:8000/api/clients 2>/dev/null; then
    echo "[run] engine up on http://127.0.0.1:8000"
    break
  fi
  sleep 0.5
done

(cd dashboard && npm run dev) &
DASH_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 3 http://localhost:3000/ 2>/dev/null; then
    echo ""
    echo "  Dashboard   http://localhost:3000"
    echo "  Engine      http://127.0.0.1:8000"
    echo ""
    echo "  Ctrl+C stops both."
    echo ""
    break
  fi
  sleep 1
done

wait

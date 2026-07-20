#!/usr/bin/env bash
#
# Strategi Canon installer and updater (macOS, Linux).
#
# Run it once to set a machine up, and run it again any time to update. It is
# idempotent by design: every step checks whether it is already done, so the
# second run is fast and the tenth run is harmless.
#
#   First install:   gh repo clone Strategi-GEO/Canon ~/strategi-canon
#                    cd ~/strategi-canon && ./install.sh
#   Later updates:   cd ~/strategi-canon && ./install.sh
#
# WHY NOT `curl … | bash`. The repository is PRIVATE, so raw.githubusercontent.com
# refuses the script itself without a credential, and a one-liner that cannot be
# fetched is not a one-liner. Cloning first with `gh`, which already holds the
# teammate's GitHub auth, is the honest shape for a private repo.
#
# WHY THIS EXISTS AT ALL, rather than shipping a packaged .app. A file downloaded
# by a BROWSER carries macOS's com.apple.quarantine attribute, and Gatekeeper then
# refuses to open it until the user right-clicks and confirms. `git` and `curl` do
# not set that attribute, so a tree that arrives this way simply runs. That removes
# the need for a paid Developer ID certificate entirely, rather than deferring it.
#
# WHAT IT DOES NOT DO. It does not fix credential distribution. server/.env still
# carries the Supabase service key and a direct DATABASE_URL, both of which grant
# full access to every client's data, and prompting for them is still handing them
# to a laptop. This is less error-prone than emailing a file, not safer. The real
# fix is moving privileged database access off teammate machines.
set -euo pipefail

REPO_URL="https://github.com/Strategi-GEO/Canon.git"
DEFAULT_DIR="$HOME/strategi-canon"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; RESET=$'\033[0m'

say()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '\n%serror:%s %s\n\n' "$RED" "$RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Locate the tree, cloning it if this script was run from outside one
# ---------------------------------------------------------------------------
# looks_like_repo mirrors tray.py's own check, so "is this a Canon folder" has one
# definition rather than two that can disagree.
looks_like_repo() { [ -f "$1/launcher.py" ] && [ -f "$1/server/app.py" ]; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if looks_like_repo "$SCRIPT_DIR"; then
    REPO_DIR="$SCRIPT_DIR"
    say "using the tree this script lives in: $REPO_DIR"
else
    REPO_DIR="${CANON_DIR:-$DEFAULT_DIR}"
    if looks_like_repo "$REPO_DIR"; then
        say "found an existing install at $REPO_DIR"
    else
        say "cloning into $REPO_DIR"
        command -v git >/dev/null 2>&1 || die "git is not installed. On macOS run: xcode-select --install"
        if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
            gh repo clone Strategi-GEO/Canon "$REPO_DIR"
        else
            warn "the GitHub CLI is not installed or not logged in"
            warn "git will ask for credentials; a GitHub password will NOT work, you need a token"
            warn "the easier path is: brew install gh && gh auth login"
            git clone "$REPO_URL" "$REPO_DIR" \
                || die "clone failed. Install the GitHub CLI and run 'gh auth login', then retry."
        fi
        looks_like_repo "$REPO_DIR" || die "clone produced no Canon tree at $REPO_DIR"
    fi
fi

cd "$REPO_DIR"

# ---------------------------------------------------------------------------
# 2. Update, but never on top of uncommitted work
# ---------------------------------------------------------------------------
if [ -d .git ]; then
    say "updating"
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        # Pulling over local edits is how someone loses an afternoon. A stale tree
        # is recoverable; a clobbered one is not, so this refuses and says why.
        warn "you have uncommitted changes here, so the update is being skipped"
        warn "commit or stash them, then run this again to pull"
    else
        BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
        git pull --ff-only origin "$BRANCH" 2>/dev/null \
            && ok "updated $BRANCH" \
            || warn "could not fast-forward $BRANCH; continuing with the tree as it is"
    fi
fi

# ---------------------------------------------------------------------------
# 3. A Python to bootstrap with
# ---------------------------------------------------------------------------
# fetch_runtimes.py downloads the interpreter the engine will actually use, but
# something has to run fetch_runtimes.py first. Any system python3 will do since
# that script is pure stdlib. When there is none, bootstrap one rather than
# telling the teammate to go install Python: removing that instruction is most of
# the reason the runtimes are bundled at all.
BOOTSTRAP_PY=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
        BOOTSTRAP_PY="$(command -v "$candidate")"
        break
    fi
done

if [ -z "$BOOTSTRAP_PY" ]; then
    say "no system Python found, fetching a temporary one to bootstrap with"
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64)  PBS_TRIPLE="aarch64-apple-darwin" ;;
        Darwin-x86_64) PBS_TRIPLE="x86_64-apple-darwin" ;;
        Linux-aarch64) PBS_TRIPLE="aarch64-unknown-linux-gnu" ;;
        Linux-x86_64)  PBS_TRIPLE="x86_64-unknown-linux-gnu" ;;
        *) die "unsupported platform: $(uname -s) $(uname -m)" ;;
    esac
    BOOT_DIR="$(mktemp -d)"
    trap 'rm -rf "$BOOT_DIR"' EXIT
    PBS_REL="20260718"; PBS_VER="3.12.13"
    curl -fsSL "https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_REL}/cpython-${PBS_VER}+${PBS_REL}-${PBS_TRIPLE}-install_only_stripped.tar.gz" \
        | tar -xz -C "$BOOT_DIR" || die "could not download a bootstrap Python"
    BOOTSTRAP_PY="$BOOT_DIR/python/bin/python3"
    ok "bootstrap Python ready (temporary, discarded when this script exits)"
else
    ok "bootstrap Python: $BOOTSTRAP_PY"
fi

# ---------------------------------------------------------------------------
# 4. The bundled runtimes
# ---------------------------------------------------------------------------
# ~280 MB of Node and CPython, checksum-verified, cached between runs. This is
# what removes "install Node 20+" and "install Python 3.11+" from setup.
say "runtimes (Node + Python, cached between runs)"
"$BOOTSTRAP_PY" canon_app/fetch_runtimes.py || die "runtime download failed"

RUNTIMES="$REPO_DIR/canon_app/build_assets/runtimes"
CANON_PY="$RUNTIMES/python/bin/python3"
CANON_NODE_BIN="$RUNTIMES/node/bin"
[ -x "$CANON_PY" ] || die "expected a bundled interpreter at $CANON_PY"
[ -x "$CANON_NODE_BIN/node" ] || die "expected bundled node at $CANON_NODE_BIN/node"

# ---------------------------------------------------------------------------
# 5. server/.env
# ---------------------------------------------------------------------------
# Never overwritten. A teammate who already has a working file must not lose it to
# a re-run, and this script runs again on every update.
ENV_FILE="$REPO_DIR/server/.env"
if [ -f "$ENV_FILE" ]; then
    ok "server/.env already present, leaving it untouched"
else
    say "server/.env"
    cat <<'EOF'

    Canon needs three values from your admin to reach its database.

    Treat them as SECRETS. They grant full access to every client's data, they
    are not scoped to you, and they are not recoverable if leaked: the only
    remedy is rotating them for everybody. Do not paste them into chat, tickets,
    or anything that keeps history.

EOF
    if [ ! -t 0 ]; then
        # Piped into bash with no terminal: there is nothing to read from, and
        # silently writing a broken file would fail later and confusingly.
        warn "not running interactively, so server/.env cannot be filled in here"
        warn "create it manually with SUPABASE_URL, SUPABASE_SECRET_KEY and DATABASE_URL"
    else
        read -r -p "    SUPABASE_URL:        " SUPABASE_URL
        read -r -s -p "    SUPABASE_SECRET_KEY: " SUPABASE_SECRET_KEY; echo
        read -r -s -p "    DATABASE_URL:        " DATABASE_URL; echo
        if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SECRET_KEY" ] || [ -z "$DATABASE_URL" ]; then
            warn "one or more values were blank; server/.env was NOT written"
            warn "run this script again when you have all three"
        else
            mkdir -p "$REPO_DIR/server"
            umask 077   # 0600: readable only by this user, before any bytes land
            cat > "$ENV_FILE" <<EOF
SUPABASE_URL=$SUPABASE_URL
SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY
DATABASE_URL=$DATABASE_URL
EOF
            chmod 600 "$ENV_FILE"
            ok "wrote server/.env (permissions 600)"
        fi
    fi
fi

# ---------------------------------------------------------------------------
# 6. A starter that uses the bundled runtimes
# ---------------------------------------------------------------------------
# The repo's checked-in "Start Canon.command" runs the SYSTEM python3, which is
# exactly the prerequisite the bundled runtimes exist to remove. This generated
# starter puts the bundled node on PATH and runs the launcher under the bundled
# interpreter, so the engine's .venv is built from it too. Generated rather than
# committed because it holds absolute paths for THIS machine.
say "starter"
STARTER="$REPO_DIR/Start Canon (installed).command"
cat > "$STARTER" <<EOF
#!/usr/bin/env bash
# Generated by install.sh. Double-click to start Strategi Canon.
# Re-run install.sh if you move this folder: the paths below are absolute.
cd "$REPO_DIR"
export PATH="$CANON_NODE_BIN:\$PATH"
exec "$CANON_PY" launcher.py "\$@"
EOF
chmod +x "$STARTER"
ok "created $(basename "$STARTER")"

# ---------------------------------------------------------------------------
# 7. Preflight: the one prerequisite that cannot be bundled
# ---------------------------------------------------------------------------
# Claude Code is what pays for generation, out of the teammate's OWN subscription,
# so it is theirs to install and log into. Nothing here can do it for them, and
# nothing here should: a shared login would be a shared bill.
say "preflight"
PROBLEMS=0
if command -v claude >/dev/null 2>&1; then
    ok "claude CLI found at $(command -v claude)"
    if [ -f "$HOME/.claude.json" ]; then
        ok "a Claude login exists on this machine"
    else
        warn "no ~/.claude.json yet: run 'claude' once, log in, then type /exit"
        PROBLEMS=$((PROBLEMS + 1))
    fi
else
    warn "claude CLI not found. Install it from https://claude.com/claude-code,"
    warn "then run 'claude' once and log in with YOUR OWN account."
    PROBLEMS=$((PROBLEMS + 1))
fi
[ -f "$ENV_FILE" ] || { warn "server/.env is still missing"; PROBLEMS=$((PROBLEMS + 1)); }

"$CANON_NODE_BIN/node" --version >/dev/null 2>&1 && ok "bundled node $("$CANON_NODE_BIN/node" --version)"
"$CANON_PY" --version >/dev/null 2>&1 && ok "bundled $("$CANON_PY" --version)"

# ---------------------------------------------------------------------------
# 8. Report
# ---------------------------------------------------------------------------
echo
if [ "$PROBLEMS" -eq 0 ]; then
    printf '%s%sStrategi Canon is ready.%s\n\n' "$BOLD" "$GREEN" "$RESET"
    printf '  Start it:  open "%s"\n' "$STARTER"
    printf '  or:        double-click "%s" in Finder\n' "$(basename "$STARTER")"
else
    printf '%s%sInstalled, with %d thing(s) still to do (listed above).%s\n' \
        "$BOLD" "$YELLOW" "$PROBLEMS" "$RESET"
    printf '  Fix those, then run this script again to re-check.\n'
fi
printf '\n  %sUpdate later:%s cd "%s" && ./install.sh\n\n' "$DIM" "$RESET" "$REPO_DIR"

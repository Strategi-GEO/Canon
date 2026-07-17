#!/usr/bin/env python3
"""Static auth checks: the unauthenticated surface, the write gate, the env boundary.

    .venv/bin/python tests/auth_check.py

Spawns no CLI, generates nothing, talks to no network. It introspects app.routes
the same way config_check.py introspects SDK options: the shape of the app is the
thing under test, so the app is imported and asked.

THE CONTRACT (server/app.py states it above the auth block): the unauthenticated
surface is EXACTLY five routes: GET /, GET /api/health, POST /api/login,
POST /api/refresh, POST /api/logout. Every other route carries require_user,
require_user_sse (the SSE route alone), or require_admin. A route someone adds
tomorrow without a dependency fails here, which is the point: the allowlist is
enforced, not remembered.
"""
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

FAILURES = []


def check(name, ok, detail=""):
    tag = "ok" if ok else "FAIL"
    print(f"  {tag:<5} {name}" + (f"  ({detail})" if detail else ""))
    if not ok:
        FAILURES.append(name)


def main():
    from fastapi.routing import APIRoute

    from server import auth as auth_mod
    from server import db as db_mod
    from server.app import app

    print("== the unauthenticated surface is exactly five routes ==")
    ALLOWED_OPEN = {
        ("GET", "/"),
        ("GET", "/api/health"),
        ("POST", "/api/login"),
        ("POST", "/api/refresh"),
        ("POST", "/api/logout"),
    }
    AUTH_DEPS = {"require_user", "require_user_sse", "require_admin"}

    def deps_of(route):
        found = set()

        def walk(dependant):
            for sub in dependant.dependencies:
                if sub.call is not None and hasattr(sub.call, "__name__"):
                    found.add(sub.call.__name__)
                walk(sub)

        walk(route.dependant)
        return found

    open_routes, secured = set(), {}
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        hit = deps_of(route) & AUTH_DEPS
        for method in route.methods - {"HEAD", "OPTIONS"}:
            if hit:
                secured[(method, route.path)] = hit
            else:
                open_routes.add((method, route.path))

    check("open surface == the five-route allowlist", open_routes == ALLOWED_OPEN,
          f"unexpected open: {sorted(open_routes - ALLOWED_OPEN)}; "
          f"missing open: {sorted(ALLOWED_OPEN - open_routes)}")
    check("every other route carries an auth dependency", len(secured) > 0,
          f"{len(secured)} secured")

    print("== the write gate: mutations are admin-only ==")
    # The one deliberate exception is POST .../answers: require_user plus an
    # in-handler role check (admin | commenter in scope), because answering the
    # evaluator's questions is the client's job, not the operator's.
    ANSWERS = ("POST", "/api/clients/{slug}/blogs/{topic}/answers")
    bad_writes = [
        (method, path)
        for (method, path), hit in secured.items()
        if method in {"POST", "PATCH", "PUT", "DELETE"}
        and "require_admin" not in hit
        and (method, path) != ANSWERS
    ]
    check("every mutation except answers requires admin", not bad_writes,
          f"non-admin writes: {sorted(bad_writes)}")
    check("answers route is authenticated", ANSWERS in secured)

    print("== the SSE variant is scoped to the SSE route alone ==")
    sse_users = [(m, p) for (m, p), hit in secured.items() if "require_user_sse" in hit]
    check("require_user_sse only on /api/runs/{run_id}/events",
          sse_users == [("GET", "/api/runs/{run_id}/events")],
          f"found: {sse_users}")

    print("== the env boundary: no auth credential reaches an agent ==")
    banned = {"SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_JWT_SECRET", "DATABASE_URL"}
    leaked = banned & set(db_mod.AGENT_ENV_ALLOW)
    check("AGENT_ENV_ALLOW carries no Supabase credential", not leaked,
          f"leaked: {sorted(leaked)}")

    print("== the dependency is pinned, not inherited ==")
    req = (REPO / "requirements.txt").read_text()
    check("requirements.txt pins PyJWT", bool(re.search(r"^PyJWT", req, re.M)))

    print("== the alg is pinned, never taken from the token header ==")
    check("JWKS algs pinned to ES256", auth_mod._JWKS_ALGS == ("ES256",))

    if FAILURES:
        print(f"\n{len(FAILURES)} FAILURE(S): {FAILURES}")
        sys.exit(1)
    print("\nall auth checks passed")


if __name__ == "__main__":
    main()

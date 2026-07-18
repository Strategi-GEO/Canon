#!/usr/bin/env python3
"""Apply one SQL migration file to the configured database.

    .venv/bin/python supabase/apply.py supabase/migrations/004_send_to_client.sql

Exists because psql is not installed on every operator machine, while psycopg always is
(the engine depends on it). It runs the file as ONE statement batch inside the file's own
transaction: every migration here opens with `begin;` and closes with `commit;`, so this
script deliberately does not add a transaction of its own and cannot half-apply one that
brackets itself properly.

The DSN comes from server/db.py, which is the only place credentials are read, so this
script never sees them and never puts them on a command line where `ps` would show them.
"""
from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO))

from server import db  # noqa: E402  (path juggling has to happen first)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    path = pathlib.Path(sys.argv[1])
    if not path.is_file():
        print(f"no such migration: {path}")
        return 2

    dsn = db._load_cfg().get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set in server/.env; nothing to apply against")
        return 2

    import psycopg

    sql = path.read_text(encoding="utf-8")
    with psycopg.connect(dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
    print(f"applied {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

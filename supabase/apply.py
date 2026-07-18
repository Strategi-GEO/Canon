#!/usr/bin/env python3
"""Apply one SQL migration file to the configured database.

    .venv/bin/python supabase/apply.py supabase/migrations/004_send_to_client.sql

Exists because psql is not installed on every operator machine, while psycopg always is
(the engine depends on it).

IT OPENS ITS OWN TRANSACTION AND THE FILE'S begin/commit RIDE INSIDE IT. The first version
of this script trusted the file to bracket itself and connected with autocommit, which is
how migration 005 half-applied on a real database: the run died on one bad statement with
every statement before it already durable, leaving a schema that matched neither the old
shape nor the new one. A migration is all-or-nothing or it is a guess, so the transaction
is the script's own responsibility, not the file's.

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
    # autocommit=False, so psycopg holds ONE transaction around the whole file and rolls the
    # lot back on any failure. The file's own begin/commit sit inside that and are harmless.
    with psycopg.connect(dsn) as conn:
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    print(f"applied {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

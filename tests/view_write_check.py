#!/usr/bin/env python3
"""No server code may DELETE, INSERT or UPDATE a VIEW.

`hard_delete_client` did exactly that against `org_membership`, a view over clients left
join orgs. Postgres refuses ("cannot delete from view"), the transaction rolled back, and
the 500 reached the browser as "Cannot reach the engine" because a Starlette 500 carries
no CORS headers. The view name reads like a table at the call site, so the class of bug is
invisible in review: this check reads the view names out of the schema and fails on any
write aimed at one.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VIEWS = set(re.findall(r"create\s+(?:or\s+replace\s+)?view\s+(?:if\s+not\s+exists\s+)?(\w+)",
                       (ROOT / "supabase" / "schema.sql").read_text(), re.I))
WRITE = re.compile(r"\b(?:delete\s+from|insert\s+into|update)\s+(\w+)", re.I)

assert VIEWS, "no views found in schema.sql: the check would pass vacuously"

bad = []
for path in sorted((ROOT / "server").rglob("*.py")):
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        for name in WRITE.findall(line):
            if name in VIEWS:
                bad.append(f"{path.relative_to(ROOT)}:{lineno}: writes to view {name!r}: {line.strip()}")

if bad:
    print("\n".join(bad))
    sys.exit(f"{len(bad)} write(s) against a view")
print(f"ok: {len(VIEWS)} views, no writes against any of them")

#!/usr/bin/env python3
"""Deleting a brand takes its client-portal login with it, and NEVER takes anyone else's.

THE HARM THIS PINS. `org_members` grants by ORG SLUG and carries no foreign key at all, so
nothing in the database cascades it off a deleted brand. `org_membership` derives org_slug as
COALESCE(orgs.slug, clients.slug), so a brand with no organisation of its own answers to its OWN
slug. A brand delete is a HARD delete, so that slug is reusable the instant it commits, and
api_create_client mints no login when `has_login` is already true. Leave the grant behind and the
next brand created with that name silently inherits the deleted brand's login, password and
`commenter` role, which the portal admits for answer writes. Nobody is told.

THE OPPOSITE ERROR IS WORSE, which is why the negative cases are here in force. Revoking on the
brand's ORGANISATION slug would destroy a login shared with every sibling brand in that org and
lock them all out to clean up one. `self_org_slug` is the discriminator and this check is its
specification.

The DB is stubbed, so this runs with no network and no database: what is under test is which slug
gets revoked, not Supabase.
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import clients  # noqa: E402

CHECKS = [0]
FAILURES = []


def check(name, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


class FakeDB:
    """The two reads self_org_slug makes: the org_membership view, and the orgs table.

    `membership` maps client_slug -> the org_slug org_membership resolves for it, which is the
    view's own COALESCE(orgs.slug, clients.slug) written out. `orgs` is the set of slugs an
    explicit orgs row owns, which is the half that must never be revoked from here.
    """

    def __init__(self, membership, orgs):
        self.membership = membership
        self.orgs = set(orgs)

    def q(self, sql, params=None, fetch="all"):
        s = " ".join(sql.split())
        if s.startswith("select org_slug from org_membership where client_slug"):
            return self.membership.get(params[0])
        if s.startswith("select 1 from orgs where slug"):
            return True if params[0] in self.orgs else None
        raise AssertionError(f"unexpected sql: {s}")


def with_db(membership, orgs):
    clients.db = FakeDB(membership, orgs)


# A brand with no organisation of its own: org_membership resolves it to its OWN slug and no
# orgs row owns that slug. Its grant belongs to it alone, so the delete takes it.
with_db({"cucoon": "cucoon"}, orgs=[])
check("a self-org brand gives up its own slug", clients.self_org_slug("cucoon") == "cucoon")

# A brand inside a real organisation. The grant is the ORG's and fans out to every sibling, so
# deleting one brand must revoke nothing at all.
with_db({"nie-retail": "new-india-electricals",
         "nie-trade": "new-india-electricals"}, orgs=["new-india-electricals"])
check("a brand inside an org gives up nothing", clients.self_org_slug("nie-retail") is None)

# THE TRAP. A brand named the same as its explicit organisation resolves to a slug EQUAL to its
# own, so a slug-equality test alone would revoke here and lock out every sibling brand. The orgs
# row is what tells the two apart.
with_db({"acme": "acme", "acme-labs": "acme"}, orgs=["acme"])
check("a brand sharing its org's slug gives up nothing", clients.self_org_slug("acme") is None)

# The same shape with no orgs row is the ordinary single-brand case, and it DOES revoke. This is
# the pair that proves the orgs read is doing the work rather than the slug comparison.
with_db({"acme": "acme"}, orgs=[])
check("the same slug with no orgs row still revokes", clients.self_org_slug("acme") == "acme")

# A brand org_membership cannot see (already soft-deleted, or the underscore fixture) resolves to
# nothing. Revoking on None would delete every grant whose org_slug is null-ish.
with_db({}, orgs=[])
check("a brand the view cannot see gives up nothing", clients.self_org_slug("gone") is None)

# --- the route's ORDERING, which no stub can observe ---
# effective_org_slug reads org_membership, and that view filters `deleted_at is null`. Resolve the
# slug after the row is gone and it reads None, so the revoke silently revokes nothing and the
# check above passes while production leaks. The order is the fix.
route = re.search(r"async def api_delete_client\(.*?\n    return None",
                  (REPO_ROOT / "server" / "app.py").read_text(), re.S)
check("api_delete_client exists", route is not None)
if route:
    body = route.group(0)
    # The CALL sites, not the bare names: this function's own docstring names self_org_slug while
    # explaining the ordering, and matching that prose passed a build whose call came last.
    resolve = body.find("clients_mod.self_org_slug")
    revoke = body.find("portal_login.deprovision_one")
    delete = body.find("clients_mod.hard_delete_client")
    check("the route resolves the org slug", resolve != -1)
    check("the route revokes the login", revoke != -1)
    check("it resolves BEFORE the row is deleted", -1 < resolve < delete,
          f"resolve={resolve} delete={delete}")
    check("it revokes BEFORE the row is deleted", -1 < revoke < delete,
          f"revoke={revoke} delete={delete}")

# The delete transaction must not have grown a write against a view again. view_write_check.py
# owns that class repo-wide; this pins the one function it was found in.
src = (REPO_ROOT / "server" / "clients.py").read_text()
fn = src[src.index("def hard_delete_client("):]
fn = fn[:fn.index("\ndef ", 1)]
check("hard_delete_client never writes to org_membership",
      not re.search(r"(?:delete\s+from|insert\s+into|update)\s+org_membership", fn, re.I))

print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for name in FAILURES:
        print(f"  - {name}")
    sys.exit(1)
print("brand_delete_check OK")

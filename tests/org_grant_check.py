#!/usr/bin/env python3
"""Moving a brand between orgs must move its client login with it. No DB, no network.

THE DEFECT THIS PINS, from live data on 2026-08-13. `org_members` grants an ORG SLUG, and the
`org_membership` view derives that slug as COALESCE(orgs.slug, clients.slug), so a brand with no
org of its own answers to its own slug. blr-brewing was granted 'blr-brewing', then moved into the
org 'bangalore-brewing-co'. The view began reporting the new slug, the grant still named the old
one, orgsForUser kept no row, and blr-brewing@portal.strategi.is logged in successfully and landed
on "No organisation is linked to this account yet" with no way forward. One column moved; the table
that decides who can see the brand did not.

THE RULE, and it is a rule about WIDENING rather than about org shapes: a grant is per ORG, so
handing someone the destination org hands them every brand in it. Carrying is therefore allowed
only where the destination holds THIS BRAND ALONE, because then the grantee could already see
everything the new grant reaches. Both lockout directions satisfy that (a self-org brand joining
its own org, and a brand leaving an org to stand alone), and the dangerous case does not.

The four arms, in the order they bite:

  1. SELF-ORG -> ORG carries the grant. The live blr-brewing case, and the whole reason this
     function exists.
  2. INTO AN ORG THAT ALREADY HAS BRANDS carries NOTHING. That org has its own login which
     already sees the arriving brand, so there is nothing to repair, and carrying would hand the
     departing org's members every other brand in the destination. This is the arm a reader is
     most likely to think is a missing feature.
  3. ORG -> SELF-ORG carries the grant, which is the same lockout read backwards: nobody holds a
     grant for a slug that only just started existing.
  4. THE OLD GRANT IS DELETED ONLY ONCE DEAD. A slug the departing org still answers to is a live
     grant for the brands that stayed, and dropping it would lock those out to fix this one.

  .venv/bin/python tests/org_grant_check.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import clients  # noqa: E402

FAILED = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}{(': ' + detail) if detail else ''}")
        FAILED.append(label)


class FakeDB:
    """Answers the three reads _carry_org_grants makes, and records every write.

    `membership` is the org_membership view as (org_slug, client_slug) pairs, which is the only
    state either guard consults. Matching on a fragment of the SQL rather than the whole string
    keeps the stub from failing on whitespace, while still being specific enough that a NEW query
    added to the function falls through to the explicit raise instead of quietly reading as one of
    these.
    """

    def __init__(self, membership):
        self.membership = list(membership)
        self.writes = []

    def q(self, sql, params=(), fetch="all"):
        text = " ".join(sql.split())
        if text.startswith("insert into org_members") or text.startswith("delete from org_members"):
            self.writes.append((text.split()[0], params))
            return None
        if "where org_slug = %s and client_slug <> %s" in text:
            org, client = params
            return 1 if any(o == org and c != client for o, c in self.membership) else None
        if "select 1 from org_membership where org_slug = %s" in text:
            (org,) = params
            return 1 if any(o == org for o, _ in self.membership) else None
        raise AssertionError(f"unstubbed query: {text}")


def run(membership, old, new, client_slug="blr-brewing"):
    real = clients.db
    fake = FakeDB(membership)
    clients.db = fake
    try:
        clients._carry_org_grants(client_slug, old, new)
    finally:
        clients.db = real
    return fake.writes


def self_org_into_org():
    """THE LIVE CASE. blr-brewing joins bangalore-brewing-co, which holds it alone."""
    print("a self-org brand joining an org of its own")
    writes = run([("bangalore-brewing-co", "blr-brewing")], "blr-brewing", "bangalore-brewing-co")
    kinds = [kind for kind, _ in writes]
    check("the grant is carried to the new org slug", "insert" in kinds,
          "the client login does not follow the brand, which is the lockout")
    check("and the dead old grant is deleted", "delete" in kinds,
          "a grant naming a slug nothing answers to is left behind")
    inserted = [p for kind, p in writes if kind == "insert"]
    check("carried TO the new slug FROM the old one",
          inserted and inserted[0] == ("bangalore-brewing-co", "blr-brewing"),
          f"{inserted}")


def into_an_org_that_has_brands():
    """THE ARM THAT MUST DO NOTHING. Carrying here hands the old org's members a brand they
    were never granted, which is the one thing this must never do on its own authority."""
    print("joining an org that ALREADY holds other brands")
    writes = run(
        [("ivory-tranquil", "ivory-tower-hotel"), ("ivory-tranquil", "tranquil-resort")],
        "tranquil-resort", "ivory-tranquil")
    check("nothing is carried", writes == [],
          f"it widened the destination org's access: {writes}")


def org_back_to_self_org():
    """The lockout backwards: the brand's new slug is one nobody holds a grant for."""
    print("a brand leaving its org to stand alone")
    writes = run([("blr-brewing", "blr-brewing")], "bangalore-brewing-co", "blr-brewing")
    check("the grant is carried", any(k == "insert" for k, _ in writes))
    check("and the emptied org's grant is deleted, because no brand answers to it now",
          any(k == "delete" for k, _ in writes))


def the_old_grant_survives_while_live():
    """A departing brand must not take the grant its siblings still need."""
    print("leaving an org that KEEPS other brands")
    writes = run(
        # The destination holds the mover alone, so the carry is allowed; the SOURCE still has a
        # brand, so its grant is still doing work for that brand.
        [("tranquil-resort", "tranquil-resort"), ("ivory-tranquil", "ivory-tower-hotel")],
        "ivory-tranquil", "tranquil-resort", client_slug="tranquil-resort")
    kinds = [k for k, _ in writes]
    check("the grant is carried to the mover's new slug", "insert" in kinds)
    check("AND THE OLD GRANT IS KEPT: the brands that stayed still need it",
          "delete" not in kinds,
          "deleting it locks out every brand left behind in that org")


def no_move_is_no_write():
    """A PATCH that names the same org must not touch the table at all."""
    print("a write that does not change the org")
    check("same slug in and out is a no-op",
          run([("acme", "acme")], "acme", "acme") == [])
    check("an unresolvable slug is a no-op, never a guess",
          run([("acme", "acme")], None, "acme") == [])


class CollisionDB:
    """Answers the two reads the read-time collision net makes, and nothing else.

    `orgs` is the set of orgs.slug values; `self_orgs` is the set of LIVE clients.slug values
    carrying org_id null. The collision is both sides holding the same string, because
    org_membership derives org_slug as coalesce(orgs.slug, clients.slug) and one org_members
    grant on it would then read two tenants.
    """

    def __init__(self, orgs=(), self_orgs=()):
        self.orgs = set(orgs)
        self.self_orgs = set(self_orgs)

    def q(self, sql, params=(), fetch="all"):
        text = " ".join(sql.split())
        if text.startswith("select 1 from orgs where slug = %s"):
            return True if params[0] in self.orgs else None
        if text.startswith("select slug from clients where slug = %s"):
            return [(params[0],)] if params[0] in self.self_orgs else []
        raise AssertionError(f"unstubbed query: {text}")


def collision_holds_the_grant_door():
    """A slug that is BOTH an org and a self-org brand must not be granted a portal login.

    THE HARM IS A SHARED LOGIN, not a misrouted publish. The write guards and the constraint
    triggers stop the collision being created; neither can reach one already in the record,
    because a constraint trigger is checked only on rows written after it exists. This net is
    what catches that, at the last moment it is still inert: a collision nobody holds a grant on
    leaks nothing.
    """
    print("the read-time collision net at the grant door")
    saved = clients.db
    try:
        clients.db = CollisionDB(orgs={"acme"}, self_orgs={"acme"})
        check("both sides present is a collision", clients.org_slug_collides("acme"))
        try:
            clients.refuse_grant_on_collision("acme")
            check("and the grant is refused", False, "it returned")
        except clients.InvalidClient as refused:
            check("and the grant is refused", True)
            check("the refusal names the portal, not a CMS key that no longer exists",
                  "portal" in str(refused).lower() and "cms" not in str(refused).lower(),
                  str(refused))
            check("it names the brand, so the operator knows which two collided",
                  "acme" in str(refused))

        # EITHER SIDE ALONE IS ORDINARY AND MUST NOT REFUSE. An org with no same-named self-org
        # brand is every real org; a self-org brand with no same-named orgs row is every brand
        # that never joined one. Refusing those would block the common case to guard the rare.
        clients.db = CollisionDB(orgs={"acme"}, self_orgs=set())
        check("an org with no colliding brand is clean", not clients.org_slug_collides("acme"))
        clients.refuse_grant_on_collision("acme")

        clients.db = CollisionDB(orgs=set(), self_orgs={"acme"})
        check("a self-org brand with no orgs row is clean",
              not clients.org_slug_collides("acme"))
        clients.refuse_grant_on_collision("acme")

        clients.db = CollisionDB(orgs={"acme"}, self_orgs={"acme"})
        check("an empty slug asks the record nothing", not clients.org_slug_collides(""))
    finally:
        clients.db = saved


if __name__ == "__main__":
    self_org_into_org()
    into_an_org_that_has_brands()
    org_back_to_self_org()
    the_old_grant_survives_while_live()
    no_move_is_no_write()
    collision_holds_the_grant_door()
    print()
    if FAILED:
        print(f"{len(FAILED)} check(s) failed")
        sys.exit(1)
    print("org_grant_check passed")

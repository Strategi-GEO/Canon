#!/usr/bin/env python3
"""portal_login: minting one client login grants membership, records the password ONCE, and
preserves every other block in the credentials file. GoTrue and the DB are stubbed, so this runs
with no network and no database: the logic under test is the provisioning flow, not Supabase.
"""
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import portal_login  # noqa: E402

CHECKS = [0]
FAILURES = []


def check(name, cond, detail=""):
    CHECKS[0] += 1
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


# --- stub the externals: the DB grant/lookup and the GoTrue admin API ---
class FakeDB:
    def __init__(self):
        self.members = set()   # org_slugs that have a grant
        self.inserts = []
        # The collision net's two reads. `orgs` is orgs.slug; `self_orgs` is the LIVE
        # clients.slug values carrying org_id null. A slug in BOTH is the collision:
        # org_membership derives org_slug as coalesce(orgs.slug, clients.slug), so one grant on
        # it would read two tenants. Empty by default, which is every ordinary case here.
        self.orgs = set()
        self.self_orgs = set()

    def q(self, sql, params=None, fetch="all"):
        s = " ".join(sql.split())
        if s.startswith("select 1 from org_members where org_slug"):
            return 1 if params[0] in self.members else None
        if s.startswith("insert into org_members"):
            org_slug, uid, role = params
            self.members.add(org_slug)
            self.inserts.append((org_slug, uid, role))
            return None
        if s.startswith("select 1 from orgs where slug = %s"):
            return True if params[0] in self.orgs else None
        if s.startswith("select slug from clients where slug = %s"):
            return [(params[0],)] if params[0] in self.self_orgs else []
        raise AssertionError(f"unexpected sql: {s}")


fake = FakeDB()
portal_login.db.q = fake.q
portal_login.config_ready = lambda: True

# A temp credentials file, pre-seeded so we can prove other blocks survive a single-org write.
tmp = Path(tempfile.mkdtemp()) / ".env.portal-credentials"
tmp.write_text(
    "# header\n\n"
    "[admin:a@x]\nemail = a@x\npassword = adminpw\n\n"
    "[org:other]\nname = Other\nemail = other@portal.strategi.is\npassword = otherpw\n\n",
    encoding="utf-8",
)
portal_login.CREDENTIALS_FILE = tmp

# --- a brand-new org: mints a user, grants, records, and returns the fresh password ---
portal_login._lookup_user_id = lambda email: None
portal_login._auth_admin = lambda method, path, payload=None: (201, {"id": "uid-new"})

res = portal_login.provision_one("acme", "Acme")
check("a new org mints a login", res["created"] is True and bool(res["password"]))
check("email is <slug>@<default domain>", res["email"] == f"acme@{portal_login.DEFAULT_DOMAIN}")
check("the grant is inserted with the client role",
      ("acme", "uid-new", portal_login._CLIENT_ROLE) in fake.inserts)
check("has_login is true for the org afterwards", portal_login.has_login("acme"))

txt = tmp.read_text(encoding="utf-8")
check("the new org block is recorded with its password",
      "[org:acme]" in txt and res["password"] in txt)
check("the other org's block is preserved", "[org:other]" in txt and "otherpw" in txt)
check("the admin block is preserved", "[admin:a@x]" in txt and "adminpw" in txt)
check("the file is owner-only (0600)", (tmp.stat().st_mode & 0o777) == 0o600)

# --- an existing GoTrue user: adopt it, return no password, and DO NOT rewrite the file ---
before = tmp.read_text(encoding="utf-8")
portal_login._lookup_user_id = lambda email: "uid-existing"
res2 = portal_login.provision_one("existing-org", "Existing")
check("an existing auth user is adopted without a password",
      res2["created"] is False and res2["password"] is None)
check("adopting still grants membership", portal_login.has_login("existing-org"))
check("adopting writes no credential block (no password to record)",
      tmp.read_text(encoding="utf-8") == before)

# --- a slug that is BOTH an org and a self-org brand is refused a login ---
# THE HARM IS ONE LOGIN READING TWO TENANTS. org_membership derives org_slug as
# coalesce(orgs.slug, clients.slug), so a slug held by an orgs row AND by a live brand with no
# org of its own resolves to one string, and a single org_members grant on it reaches both. The
# write guards and the constraint triggers stop that state being created; neither can reach one
# already in the record, because a constraint trigger is checked only on rows written after it
# exists. This is the net, at the last moment the collision is still inert.
fake.orgs.add("shared")
fake.self_orgs.add("shared")
minted_before = list(fake.inserts)
# A RECORDING GoTrue stub, so "no user was created" is asserted rather than assumed. The lambdas
# above answer but remember nothing, and the point of refusing before the auth call is that a
# refused provision leaves nothing behind for a later run to adopt.
auth_calls = []
portal_login._lookup_user_id = lambda email: (auth_calls.append(("lookup", email)) or None)
portal_login._auth_admin = lambda method, path, payload=None: (
    auth_calls.append(("create", path)) or (201, {"id": "uid-collide"}))
refused = None
try:
    portal_login.provision_one("shared", "Shared")
except portal_login.PortalLoginError as exc:
    refused = exc
check("a colliding slug is refused a portal login", refused is not None)
check("the refusal names the shared login rather than a CMS key",
      refused is not None and "portal" in str(refused).lower()
      and "cms" not in str(refused).lower(), str(refused))
# BEFORE THE GoTrue CALL, so a refusal leaves no user behind to be adopted later by whoever
# fixes the collision and re-runs. Checked by both externals staying untouched.
check("no grant is written for it", fake.inserts == minted_before)
check("and GoTrue is never called for it", auth_calls == [], str(auth_calls))

# Either side ALONE is ordinary and must still mint: an org with no same-named self-org brand is
# every real org, and refusing those would block the common case to guard the rare one.
fake.self_orgs.discard("shared")
ok_again = portal_login.provision_one("shared", "Shared")
check("an org with no colliding brand still mints", ok_again["created"] is True)

# --- missing config raises, never sys.exits (the whole reason this is not the CLI) ---
portal_login.config_ready = lambda: False
raised = False
try:
    portal_login.provision_one("x", "X")
except portal_login.PortalLoginError:
    raised = True
except SystemExit:  # pragma: no cover - the failure this test exists to prevent
    raised = False
check("missing config raises PortalLoginError, not SystemExit", raised)

print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for name in FAILURES:
        print(f"  - {name}")
    sys.exit(1)
print("portal_login_check OK")

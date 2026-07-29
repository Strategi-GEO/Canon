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

    def q(self, sql, params=None, fetch="all"):
        s = " ".join(sql.split())
        if s.startswith("select 1 from org_members where org_slug"):
            return 1 if params[0] in self.members else None
        if s.startswith("insert into org_members"):
            org_slug, uid, role = params
            self.members.add(org_slug)
            self.inserts.append((org_slug, uid, role))
            return None
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

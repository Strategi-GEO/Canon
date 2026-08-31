#!/usr/bin/env python3
"""Static checks for the four repurpose channels. Touches no database and opens no session.

THE ONE INVARIANT THIS FILE EXISTS FOR: bluesky and x are FULL channels on every surface and are
NOT in the CMS publish hook's auto set. Those two facts live in two constants that differ by two
entries, which is exactly the shape a future reader tidies into one. Doing that would make every
CMS or website publish silently spawn two more SDK sessions per blog, on a pair of tabs whose
whole point is that the operator picks the blogs by hand. Nothing else in the repo would fail, so
this file is what fails instead.

The rest is drift between the places a channel's NAME is written down. Python and TypeScript
cannot check each other, and the label map is read by the .docx cover, the lead prompt, the live
status feed and the operator's notifications, so a channel missing an entry is four wrong strings
rather than a crash.

EXPECTED IS DELIBERATELY HARDCODED. A fifth channel makes this file fail until someone edits it,
which is the point: the list below IS the checklist for adding one, and every entry names a place
that would otherwise be found by an operator rather than by a test.

  .venv/bin/python tests/channel_check.py
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import repurpose  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


EXPECTED = ("linkedin", "medium", "bluesky", "x")
MANUAL_ONLY = ("bluesky", "x")


def read(rel):
    return (REPO_ROOT / rel).read_text(encoding="utf-8")


print("the enums")
check("every channel is registered", set(repurpose.CHANNELS) == set(EXPECTED),
      f"got {repurpose.CHANNELS}")
check("the auto set is a STRICT subset of the channels",
      set(repurpose.AUTO_CHANNELS) < set(repurpose.CHANNELS),
      f"got {repurpose.AUTO_CHANNELS} against {repurpose.CHANNELS}")
for ch in MANUAL_ONLY:
    check(f"{ch} is a real channel", ch in repurpose.CHANNELS)
    # THE LOAD-BEARING ONE. See the module docstring.
    check(f"{ch} is NEVER auto-generated on publish", ch not in repurpose.AUTO_CHANNELS)
check("channel.py aliases the same tuple rather than keeping its own",
      "CHANNELS = repurpose.CHANNELS" in read("server/channel.py"))

print("\nthe publish hook reads the auto set, not the channel set")
hook = read("server/app.py")
body = hook[hook.index("async def _auto_repurpose_on_publish"):]
body = body[:body.index("cms_routes.after_publish")]
check("the hook loops AUTO_CHANNELS", "for ch in repurpose.AUTO_CHANNELS:" in body)
check("and never loops CHANNELS", "for ch in repurpose.CHANNELS:" not in body)

print("\nevery channel has a name everywhere one is written down")
for ch in EXPECTED:
    check(f"{ch} has a python label", bool(repurpose.CHANNEL_LABELS.get(ch)))
    # The skill dir is reached by f-string (repurpose._lead_prompt), so a missing one is not an
    # ImportError: the session finds no skill, writes no post.md, and the run ends `failed`.
    skill = REPO_ROOT / ".claude" / "skills" / f"{ch}-repurposer" / "SKILL.md"
    check(f"{ch}-repurposer/SKILL.md exists", skill.is_file(), str(skill))
    if skill.is_file():
        head = skill.read_text(encoding="utf-8").splitlines()[:4]
        check(f"{ch}-repurposer frontmatter names itself",
              head and head[0] == "---" and f"name: {ch}-repurposer" in head[1],
              f"got {head[:2]}")

print("\nthe typescript union and its Record maps agree with python")
union = re.search(r"export type RepurposeChannel =([^;]+);", read("dashboard/src/types/index.ts"))
check("the RepurposeChannel union parses", union is not None)
if union:
    members = set(re.findall(r'"([a-z]+)"', union.group(1)))
    check("the union carries exactly the python channels", members == set(EXPECTED),
          f"got {sorted(members)}")
# tsc proves the Record<RepurposeChannel, _> maps are total; what it cannot see is a channel
# missing from a plain Set, so those two are checked as text.
for rel, name in (
        ("dashboard/src/lib/server/portal-data.ts", "CHANNELS"),
        ("dashboard/src/portal/nav.ts", "SECTIONS"),
        ("dashboard/src/portal/nav.ts", "TOPIC_SECTIONS")):
    text = read(rel)
    # `const SECTIONS` and not `SECTIONS`, or TOPIC_SECTIONS' own declaration matches first.
    body = text[text.index(f"const {name} = new Set("):]
    body = body[:body.index(")")]
    missing = [c for c in EXPECTED if f'"{c}"' not in body]
    check(f"{name} in {Path(rel).name} carries every channel", not missing,
          f"missing {missing}")

print("\nthe admin routes exist on disk (they are file-based, so a missing dir is a 404)")
brand = REPO_ROOT / "dashboard/src/app/admin/org/[org]/[brand]"
for ch in EXPECTED:
    check(f"/{ch} page", (brand / ch / "page.tsx").is_file())
    check(f"/{ch}/[topic] review page", (brand / ch / "[topic]" / "page.tsx").is_file())

print("\nthe database admits every channel")
constraint = read("supabase/migrations/037_channel_bluesky_x.sql")
schema = read("supabase/schema.sql")
for ch in EXPECTED:
    check(f"migration 037 admits {ch}", f"'{ch}'" in constraint)
    check(f"schema.sql admits {ch}",
          f"'{ch}'" in schema[schema.index("create table channel_posts"):][:900])

print("\nno raw channel slug reaches a person")
# The defect this catches: f"a {channel} post" renders "a x post". Every operator-facing string
# goes through CHANNEL_LABELS instead.
for rel in ("server/notify.py", "server/repurpose.py", "server/app.py"):
    text = read(rel)
    # notify._channel_piece's `return ... f"{channel} post"` is the ONE sanctioned use: it is the
    # unknown-channel fallback INSIDE the helper every message is supposed to call, so scanning it
    # would fail the very indirection this check exists to require. Dropped by name rather than by
    # a looser regex, so a bare slug anywhere else still fails.
    text = text.replace('return repurpose.CHANNEL_LABELS.get(channel, f"{channel} post")', "")
    raw = re.findall(r'f"[^"\n]*\{(?:the_channel|channel|ch)\}[ ]+(?:post|article|thread)', text)
    check(f"{Path(rel).name} interpolates no bare channel slug before a noun", not raw,
          f"got {raw}")

print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
if FAILURES:
    print("FAILED: " + ", ".join(FAILURES))
    sys.exit(1)
print("channel_check OK")

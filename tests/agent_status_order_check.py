"""Every subagent announces its stage BEFORE it reads anything.

WHY THIS TEST EXISTS. status.jsonl is the only progress feed the engine has, and every agent
writes its own lines. So the window between "the lead dispatched this agent" and "this agent
appended its first status line" is a window in which a blog that is working is INDISTINGUISHABLE
from a blog still parked on the semaphore: the operator's queue reads QUEUED for both.

NOBODY EVER DECIDED TO HAVE THAT WINDOW. The reads-first ordering shipped in the initial commit
(9db3f10) and was then WIDENED TWICE by commits that were each correct about the read they added
and blind to what it did to the feed: b5bd2c3 put roadmap-row.md ahead of the status line, and
485a819 put the 12KB rubric.md ahead of it. Measured over the 54 sessions on disk, that left a
retry (where the lead skips the researcher and dispatches the writer straight into its reading
list) reading QUEUED for a median of 413 seconds while it was already working.

A comment saying "keep the status line first" is what those two commits would have walked past.
This is the check that fails instead.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server import runner  # noqa: E402

# The directives that mean "go and read a file". A start line has to come before all of them.
READ_MARKERS = (
    "read clients/<slug>/client.md",
    "read <out_dir>/roadmap-row.md",
    "Read <out_dir>/roadmap-row.md",
    "BEFORE you draft, read",
    "Your inputs are <out_dir>/blog.md",
)

failures = []
for name, agent in runner._agent_definitions().items():
    prompt = agent.prompt
    start = prompt.find("--event start")
    if start < 0:
        failures.append(f"{name}: prompt never tells the agent to write an --event start line")
        continue
    for marker in READ_MARKERS:
        at = prompt.find(marker)
        if 0 <= at < start:
            failures.append(
                f"{name}: read directive {marker!r} at char {at} comes BEFORE the "
                f"--event start line at char {start}. The queue will read QUEUED for as long "
                f"as that read takes."
            )
    # Belt and braces: the announcement must be near the top, not merely ahead of the reads.
    if start > 700:
        failures.append(
            f"{name}: the --event start line sits at char {start} of {len(prompt)}. It is the "
            f"agent's first action, so it belongs in the opening lines."
        )

for line in failures:
    print(f"[FAIL] {line}")
if failures:
    raise SystemExit(f"{len(failures)} ordering failure(s)")
print(f"[PASS] all {len(runner._agent_definitions())} agents announce their stage before any read")

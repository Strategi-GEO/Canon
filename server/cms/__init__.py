"""Publishing a finished blog to the client's own website.

THIS PACKAGE IS DELIBERATELY SEPARATE FROM THE ENGINE. Nothing under server/cms
is imported by runner.py, ledger.py, roadmap.py, or facts.py, and nothing in the
generation pipeline calls into here. The whole package hangs off ONE operator
action: the Post button in the preview drawer. Delete this directory and the
factory still researches, writes, gates, and scores exactly as before.

Keep it that way. A future reader wanting to publish automatically at the end of
a run should not reach in from runner.py: shipping is a human decision, and a
push here puts the article live on a client's public site (see gate.py).

THE NAME IS HISTORICAL. This package existed to file drafts into the Strategi
CMS, which is gone; what is left publishes to whichever platform the brand's own
website runs. The directory keeps its name because renaming it would touch every
import for no behaviour, and `cms` still reads as "the publishing half".

Six modules, six jobs:
- payload.py    blog.md + ledger row -> the neutral article. Pure, deterministic, no I/O.
- meta_gen.py   the written SEO title and description, best effort, never blocking.
- gate.py       the only-publish-done-and-approved checks. The refusal, not the button, is the guard.
- sites.py      which platform a brand publishes to, and the payload -> article adapter.
- wordpress.py  the one driver: its connect, its push, its retraction.
- routes.py     the single endpoint the button hits.
"""
from .gate import PublishRefused, assert_publishable
from .payload import build_payload, source_run_id
from .routes import router

__all__ = [
    "PublishRefused",
    "assert_publishable",
    "build_payload",
    "router",
    "source_run_id",
]

"""Pushing a finished blog to the Strategi CMS as a draft.

THIS PACKAGE IS DELIBERATELY SEPARATE FROM THE ENGINE. Nothing under server/cms
is imported by runner.py, ledger.py, roadmap.py, or facts.py, and nothing in the
generation pipeline calls into here. The whole package hangs off ONE operator
action: the Post button in the preview drawer. Delete this directory and the
factory still researches, writes, gates, and scores exactly as before.

Keep it that way. A future reader wanting to publish automatically at the end of
a run should not reach in from runner.py: shipping is a human decision, and the
CMS cannot tell an approved draft from an unvetted one (see gate.py).

Four modules, four jobs:
- payload.py  blog.md + ledger row -> the JSON body. Pure, deterministic, no I/O.
- gate.py     the only-push-done check. The refusal, not the button, is the guard.
- client.py   the HTTP call, its auth, and its backoff.
- routes.py   the single endpoint the button hits.
"""
from .client import CmsError, push_draft
from .gate import PublishRefused, assert_publishable
from .payload import build_payload, source_run_id
from .routes import router

__all__ = [
    "CmsError",
    "PublishRefused",
    "assert_publishable",
    "build_payload",
    "push_draft",
    "router",
    "source_run_id",
]

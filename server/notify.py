#!/usr/bin/env python3
"""Email to the operator for the four things nothing else tells them about.

WHAT EARNS AN EMAIL, and the test every candidate had to pass: the operator cannot learn it by
looking at a screen they were already looking at. The dashboard bell
(dashboard/src/lib/notifications.ts) already covers "I am at my desk", and it covers it better,
because it diffs two polls and links straight to the article. Mail is for the gap the bell cannot
reach: a browser tab that is not open. So a blog finishing does NOT send mail, and neither does a
publish, because the operator pressed the button themselves. Four events do:

  1. A client asked for a change. It blocks the send door until it is cleared.
  2. A client approved an article. The bytes are locked and a CMS push is owed.
  3. A client answered an evaluator's question form. GEO_ANSWERS_PICKUP is off by default
     (server/app.py:254), so nothing dispatches the rerun those answers are owed until a person
     clicks it. This is the one that genuinely strands.
  4. The engine broke: the silent-death breaker halted dispatch, or the stall watchdog reclaimed
     a wedged slot. CLAUDE.md notes that a wedged queue "read exactly like an idle engine" from
     every surface an operator has, which is the whole reason this one is here.

WHY THIS IS PYTHON AND NOT A POSTGRES TRIGGER, which was the real design question, since three of
these four are things a CLIENT did and the client never touches this process at all. The portal
is hosted and engine-less: it calls SECURITY DEFINER RPCs over PostgREST with the client's own
JWT, so there is no call site in server/ to hook and the events are learned by POLLING (below).
A trigger calling pg_net would beat that poll and would fire with this machine switched off.
It is still not worth it, for one reason that outranks the rest: every action the mail is asking
the operator to TAKE, the rerun, the send, the CMS push, runs through this engine. Mail that
arrives while the engine is down reports work that cannot be started until the engine is up, and
the dashboard says the same thing the moment it is. Against nothing gained, the trigger route
costs enabling pg_net on a live database, a second copy of all four templates written in plpgsql,
and either a Vault secret or a new ungated reader into engine_secrets, whose migration (028)
deliberately admits no caller without an admin JWT. Event 4 could not go there in any case:
status_events carries no `died` column, the stall watchdog never commits at all, and the breaker's
entire state is a module-level dict, so "the engine broke" is invisible to Postgres by
construction.

NEVER RAISES, ANYWHERE. Every entry point swallows its own failures. Three of the four callers
are a watchdog, a circuit breaker and a background sweep, and a notifier that can throw inside
those is a notifier that stops the thing it was meant to be watching. A dropped email is a thing
you find later on the dashboard; a watchdog that died on an SMTP timeout is a queue that stays
wedged.

OFF UNTIL CONFIGURED. With no RESEND_API_KEY in server/.env every call here is a no-op that logs
once at debug. That is what makes it safe to wire into runner.py: a teammate who has never heard
of Resend gets exactly the engine they had before.
"""
from __future__ import annotations

import asyncio
import logging
import threading

import httpx

from server import db

log = logging.getLogger(__name__)

# ONE RECIPIENT, ON PURPOSE. app_admins holds two rows and only one of them has ever done
# anything: tech@strategi.is owns every send, publish and comment on record, while the other was
# seeded the same day and has no activity at all. Mailing "every admin" would therefore mail a
# dormant account forever, and admin identity carries no per-brand scope to route by anyway
# (server/auth.py:176 returns is_admin with an empty roles map), so there is nothing here to
# route ON. A constant is honest about that; a recipients table would imply a choice nobody makes.
TO = "tech@strategi.is"

# Until strategi.is is verified in Resend, this is the only sender that works, and it delivers
# ONLY to the address that owns the Resend account. Set RESEND_FROM in server/.env the moment the
# domain goes green: "Canon <notifications@strategi.is>".
_FALLBACK_FROM = "Canon <onboarding@resend.dev>"

_ENDPOINT = "https://api.resend.com/emails"
_TIMEOUT = 15

# Two minutes. The events are a person acting in a browser, so the operator is never waiting on
# this the way they wait on a run, and the sweep is four small indexed reads. Live counts today
# are 0 client comments, 0 answered forms and 1 approval across the whole database, so this is
# nearer a heartbeat than a workload.
POLL_SECONDS = 120

_backfilled = False


def _configured() -> str:
    """The API key, or "" when this machine has none. Read through db.config_value, never
    os.environ, so RULE 1 in server/db.py holds and the key cannot ride into a Claude session:
    agent_env() filters os.environ, and this value was never in it to be filtered."""
    return db.config_value("RESEND_API_KEY")


def _claim(dedupe_key: str, kind: str) -> bool:
    """True if THIS caller won the right to send. False means someone already did.

    The insert IS the lock, so two pollers on two machines cannot both mail one event. See the
    migration's header for why the claim happens before the send and not after.
    """
    row = db.q(
        """insert into admin_notifications (dedupe_key, kind) values (%s, %s)
           on conflict (dedupe_key) do nothing
           returning dedupe_key""",
        (dedupe_key, kind), fetch="one")
    return row is not None


def _deliver(dedupe_key: str, kind: str, subject: str, body: str) -> None:
    """Claim, then POST. Runs on its own thread; see notify() for why."""
    try:
        key = _configured()
        if not key:
            log.debug("notify: no RESEND_API_KEY, dropping %s", dedupe_key)
            return
        if not _claim(dedupe_key, kind):
            return
        response = httpx.post(
            _ENDPOINT, timeout=_TIMEOUT,
            headers={"Authorization": f"Bearer {key}"},
            json={
                "from": db.config_value("RESEND_FROM") or _FALLBACK_FROM,
                "to": [TO],
                "subject": subject,
                "text": body,
            })
        if response.status_code >= 300:
            # The claim is deliberately NOT rolled back. A failing key or an unverified sender
            # fails identically on every retry, and re-claiming would mail the whole backlog the
            # day someone fixes it. The log line is the recovery path.
            log.warning("notify: Resend refused %s (%s): %s",
                        dedupe_key, response.status_code, response.text[:300])
    except Exception:
        log.exception("notify: could not send %s", dedupe_key)


def notify(kind: str, dedupe_key: str, subject: str, body: str) -> None:
    """Send one email, at most once ever for this dedupe_key. Returns immediately.

    THE THREAD IS NOT DECORATION. Two of the four callers are synchronous functions running on
    the event loop's thread (_note_silent_death and _sweep_slots in server/runner.py), and both
    a 15-second HTTP timeout and a database round trip would block every other blog in the
    process while they ran. Off-loading here rather than at each call site means no caller has to
    know which context it is in, and a daemon thread cannot hold up interpreter shutdown.
    """
    threading.Thread(
        target=_deliver, args=(dedupe_key, kind, subject, body),
        name=f"notify-{kind}", daemon=True).start()


# ---------------------------------------------------------------------------
# 4. The engine broke. Called from server/runner.py, in process, at the moment it happens.
# ---------------------------------------------------------------------------

def engine_halted(strikes: int, last: str, tripped_at: float) -> None:
    """The silent-death breaker tripped: dispatch is halted engine-wide.

    Keyed on the trip instant, so the cooldown expiring and a later trip mail again (that is a
    second outage) while the one trip cannot mail twice. Never scoped to a brand: the thing that
    died is the ACCOUNT, and saying otherwise would read as one client's problem while every
    brand in the repo is halted.
    """
    notify(
        "engine_halted", f"engine_halted:{tripped_at:.0f}",
        "Canon: dispatch halted, the engine is not opening new sessions",
        f"{strikes} blog sessions in a row died within seconds having written no status line, so "
        f"the engine has stopped dispatching for every brand.\n\n"
        f"Most recent: {last}\n\n"
        "The usual cause is the Claude account's usage window being exhausted. Dispatch resumes "
        "on its own after the cooldown, or the moment any session writes a status line. Nothing "
        "is lost: topics that never started are untouched and retry clean.")


def slot_reclaimed(client_slug: str, topic_slug: str, stalled_for: float, at: float) -> None:
    """The stall watchdog took a queue slot back from a session that ignored a cancel.

    Worth its own mail rather than folding into the above, because the operator's next act is
    different: a halted engine needs waiting out, a wedged slot needs the topic looked at.

    KEYED ON THE INSTANT, NOT THE DURATION, the same way engine_halted keys on tripped_at. A
    duration is not unique: the watchdog cancels at a fixed stall timeout and reclaims a fixed
    grace later, so two wedges of the same topic land on very nearly the same number of seconds
    by construction, and the second reclaim would find the first one's key already claimed and
    mail nothing. The duration stays in the body, where it is the number worth reading.
    """
    notify(
        "slot_reclaimed", f"slot_reclaimed:{client_slug}:{topic_slug}:{at:.0f}",
        f"Canon: reclaimed a wedged queue slot from {client_slug}/{topic_slug}",
        f"{client_slug}/{topic_slug} held a queue slot for {stalled_for / 60:.0f} minutes without "
        "writing anything and did not answer a cancel, so the engine took the slot back and wrote "
        "the topic a terminal failed line.\n\n"
        "The queue is moving again. That topic reached no verdict, so its score is not a "
        "judgement of the draft and the right response is to generate it again.")


# ---------------------------------------------------------------------------
# 1-3. What a client did. Learned by polling, because the portal never calls this process.
# ---------------------------------------------------------------------------
#
# Each query returns (dedupe_key, subject, body). The KEY carries the dedupe rule and is the only
# clever part: it names the event, not the row that revealed it.
#
# The 30-day floor on every arm is a bound on the scan and nothing else. Anything older than that
# was either already claimed or belongs to a machine that has been off for a month, and mailing a
# month-old change request helps nobody.

# THE ROUND IS THE SEND STAMP, and `c.created_at > t.sent_to_client_at` is what makes that true
# rather than merely intended. It is the house predicate already: server/blog_edit.py:889 computes
# change_round_open with exactly this comparison, and every other consumer of the state agrees.
#
# WITHOUT IT THE KEY IS ACTIVELY WRONG, in both directions at once, because sent_to_client_at is
# read at QUERY time and not frozen at comment time. Re-send a topic and every historic comment
# on it re-keys to the new stamp: the round the operator dealt with weeks ago mails a second time
# under its new key, and a genuine new request arriving in that fresh round finds the key already
# claimed by those historic rows and is swallowed. Adding the predicate fixes both, because a
# comment from before the send is no longer part of the round at all, and it retires the coalesce
# with it: an unsent topic has no round to be in.
_CHANGES_SQL = """
    select distinct
           'changes:' || c.topic_id || ':' || t.sent_to_client_at::text,
           cl.name, t.slug
      from blog_comments c
      join topics  t  on t.id = c.topic_id
      join clients cl on cl.id = c.client_id
     where c.author = 'client'
       and c.parent_id is null
       and t.sent_to_client_at is not null
       and c.created_at > t.sent_to_client_at
       and c.created_at > now() - interval '30 days'
"""

_CHANGES_CHANNEL_SQL = """
    select distinct
           'changes-ch:' || c.channel_post_id || ':' || p.sent_to_client_at::text,
           cl.name, p.channel
      from channel_post_comments c
      join channel_posts p  on p.id = c.channel_post_id
      join clients       cl on cl.id = c.client_id
     where c.author = 'client'
       and p.sent_to_client_at is not null
       and c.created_at > p.sent_to_client_at
       and c.created_at > now() - interval '30 days'
"""

_APPROVED_SQL = """
    select 'approved:' || t.id || ':' || t.client_approved_at,
           cl.name, t.slug
      from topics t
      join clients cl on cl.id = t.client_id
     where t.client_approved_at is not null
       and t.client_approved_at > now() - interval '30 days'
"""

_APPROVED_CHANNEL_SQL = """
    select 'approved-ch:' || p.id || ':' || p.client_approved_at,
           cl.name, p.channel
      from channel_posts p
      join clients cl on cl.id = p.client_id
     where p.client_approved_at is not null
       and p.client_approved_at > now() - interval '30 days'
"""

_ANSWERS_SQL = """
    select distinct
           'answers:' || r.topic_id || ':' || coalesce(r.blog_version_id::text, 'noversion'),
           cl.name, t.slug
      from review_notes r
      join topics  t  on t.id = r.topic_id
      join clients cl on cl.id = r.client_id
     where r.author = 'client'
       and r.parent_id is not null
       and r.created_at > now() - interval '30 days'
"""


def _client_events() -> list[tuple[str, str, str, str]]:
    """Every client act currently on record, as (kind, dedupe_key, subject, body).

    Returns them ALL, claimed or not: _deliver's claim is what makes the send once-only, so this
    stays a pure read and the dedupe lives in exactly one place.
    """
    out: list[tuple[str, str, str, str]] = []

    for key, brand, topic in db.q(_CHANGES_SQL) or []:
        out.append((
            "changes_requested", key,
            f"{brand} requested changes on {topic}",
            f"{brand} has asked for changes on the article {topic}.\n\n"
            "The article is back with the team and the send door stays refused until the "
            "suggestions are resolved or dismissed."))

    for key, brand, channel in db.q(_CHANGES_CHANNEL_SQL) or []:
        out.append((
            "changes_requested", key,
            f"{brand} requested changes on a {channel} post",
            f"{brand} has asked for changes on their {channel} post.\n\n"
            "It is back with the team until the suggestions are resolved or dismissed."))

    for key, brand, topic in db.q(_APPROVED_SQL) or []:
        out.append((
            "client_approved", key,
            f"{brand} approved {topic}",
            f"{brand} has approved the article {topic}, so those exact bytes are now locked: "
            "no edit, no comment and no new version is accepted against it.\n\n"
            "It is waiting on a CMS push."))

    for key, brand, channel in db.q(_APPROVED_CHANNEL_SQL) or []:
        out.append((
            "client_approved", key,
            f"{brand} approved a {channel} post",
            f"{brand} has approved their {channel} post. It is locked and ready to go out."))

    for key, brand, topic in db.q(_ANSWERS_SQL) or []:
        out.append((
            "answers_submitted", key,
            f"{brand} answered the questions on {topic}",
            f"{brand} has answered the evaluator's questions on {topic}.\n\n"
            "Nothing runs on its own from here: automatic pickup is off, so the article sits "
            "with the answers recorded until someone dispatches the rerun they are owed. Until "
            "that rerun lands, the article ships nothing."))

    return out


# The backfill's own record that it finished. A key in the same table it writes, so it costs no
# schema and cannot disagree with the thing it describes.
_BACKFILL_DONE = "backfill:done"


def backfill() -> int:
    """Claim everything already on record WITHOUT mailing it, once, on a fresh install.

    Without this the first sweep on an engine that has been running for months mails the entire
    history in one burst: every approval, every change request, every answered form, all of them
    long since dealt with.

    THE PROBE IS A SENTINEL AND NOT AN EMPTY TABLE, because "empty" answers a different question
    than the one being asked. Four writers share this table, so emptiness stops meaning "the
    backfill has not run" the moment any of the others gets there first, and both ways that
    happens end in the burst this function exists to prevent. A breaker trip or a reclaimed slot
    on a machine whose key was added mid-process claims a row before any sweep has run, and the
    next start then reads a non-empty table and skips the backfill entirely. A backfill that dies
    part way through, on a pool timeout against the engine's shared pool, leaves its own rows
    behind and disqualifies its own retry.

    THE SENTINEL IS CLAIMED LAST, which is what makes a partial run self-healing rather than
    merely detectable. Every claim is durable on its own, so a run that dies at event 13 of 40
    leaves 12 events claimed and NO sentinel; the next tick re-runs, the 12 conflict harmlessly,
    the remaining 28 are claimed, and only then does the sentinel land. Bracketing the whole
    thing in one transaction would work too and buys nothing here: this is idempotent, and the
    smaller mechanism is the one with no transaction to hold open across forty round trips.
    """
    if db.q("select 1 from admin_notifications where dedupe_key = %s",
            (_BACKFILL_DONE,), fetch="val"):
        return 0
    claimed = 0
    for kind, key, _subject, _body in _client_events():
        if _claim(key, kind):
            claimed += 1
    _claim(_BACKFILL_DONE, "backfill")
    if claimed:
        log.info("notify: first run, marked %d existing client events as already reported",
                 claimed)
    return claimed


def sweep() -> None:
    """One poll. Blocking; call it from a thread."""
    global _backfilled
    try:
        if not _backfilled:
            backfill()
            _backfilled = True

        events = _client_events()
        if not events:
            return
        # DROP THE ALREADY-SENT ONES HERE, in one read, rather than letting each spawn a thread
        # that discovers its key is taken. The queries look back 30 days, so on a busy month this
        # is the difference between one indexed select per tick and dozens of threads doing a
        # conflicting insert apiece, every two minutes, forever. The claim inside _deliver stays
        # exactly as it is: this is an optimisation and the claim is the correctness, so a key
        # that slips through between this read and that insert is still only sent once.
        keys = tuple(key for _kind, key, _s, _b in events)
        already = {row[0] for row in db.q(
            "select dedupe_key from admin_notifications where dedupe_key = any(%s)",
            (list(keys),)) or []}
        for kind, key, subject, body in events:
            if key not in already:
                notify(kind, key, subject, body)
    except Exception:
        # A sweep that raises kills run_forever's task and the operator learns nothing ever
        # again, silently. Log it and take the next tick.
        log.exception("notify: sweep failed")


async def run_forever() -> None:
    """Poll for client acts until the process ends. Started from server/app.py."""
    if not _configured():
        log.info("notify: no RESEND_API_KEY, admin email notifications are off")
        return
    log.info("notify: admin email notifications on, to %s, every %ds", TO, POLL_SECONDS)
    while True:
        await asyncio.to_thread(sweep)
        await asyncio.sleep(POLL_SECONDS)

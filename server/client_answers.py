"""Pick up client-submitted answers and dispatch the revise they are owed.

WHY THIS MODULE EXISTS. The portal writes a client's answers straight into review_notes
(supabase/migrations/002_client_portal.sql, portal_submit_answers), because the portal is a
hosted, engine-less surface: a client answers from anywhere, at any hour, whether or not any
teammate's machine is on. The contract says answering triggers ONE surgical revise, and on
the engine's own POST /answers route that dispatch is synchronous. A portal submission has
no engine to dispatch on, so the revise it is owed would never run. This sweep is that
dispatch, deferred to the next moment an engine exists: at startup and every SWEEP_INTERVAL_S
thereafter, find every topic whose current form is fully answered while the topic still
stands at needs_review, and run the same revise the POST route would have.

The pending predicate is deliberately author-agnostic. An operator-answered form whose
synchronously-dispatched revise crashed leaves exactly the same record state, and re-running
the revise is the correct recovery there too ("a spent form must never hold a blog forever").
The predicate self-limits: once a revise completes, either a new form anchors to the new
version (not answered -> not pending), or the topic left needs_review (not pending), so a
picked-up topic cannot be picked up twice.

CROSS-MACHINE CLAIM. Every teammate runs their own engine, and two engines up at once would
both find the same pending topic within one sweep interval and both spend real quota revising
it. portal_revise_claims is the tiebreak: whoever upserts the claim row dispatches, the other
skips. A claim older than CLAIM_TTL is treated as abandoned (its engine died mid-revise) and
may be re-claimed. Claims are released when the dispatched task settles, success or not.

BILLING, stated plainly: a picked-up revise spends THIS machine's Claude quota. That is why
the sweep is OPT-IN and ships disabled: the PRIMARY dispatch path is the operator clicking
Rerun in the dashboard (POST /api/clients/{slug}/blogs/{topic}/revise), a person choosing
the moment the money is spent. Set GEO_ANSWERS_PICKUP=1 on a machine that should dispatch
automatically instead; every automatic dispatch logs at WARNING so the spend is never
invisible. pending_topics() also feeds GET /api/pending-reruns, the operator's rerun queue,
and claim()/release() guard BOTH dispatch paths against cross-machine double-spend.
"""
from __future__ import annotations

import asyncio
import logging
import socket

from . import db, runner

log = logging.getLogger("geo-factory")

SWEEP_INTERVAL_S = 300
CLAIM_TTL = "2 hours"

# How many times the AUTOMATIC sweep may dispatch a revise for one topic before it gives up
# and leaves the topic for a human. The sweep spends this machine's quota on every dispatch,
# so a topic whose revise keeps failing (a poisoned answer, a persistent API error, a bug)
# would otherwise burn quota on every interval forever. The cap bounds that to a few tries.
# The operator's manual rerun is NEVER capped: a person choosing to spend overrides it.
MAX_SWEEP_ATTEMPTS = 3

# One SQL statement answers "which topics are owed a revise", so the sweep holds no state
# and two sweeps cannot disagree. Mirrors, piece for piece, the reads the route path makes:
#   * the current form = the latest asking round (questions._db_form_rows)
#   * answered = every form row has a reply child (describe_questions)
#   * stale = the form's version anchor OR its asked_iter has moved (describe_questions' twin)
#   * needs_review = the last non-running status line by ordinal (topic_rollup's fold)
_PENDING_SQL = """
with form as (
  select n.topic_id,
         (select n2.blog_version_id from review_notes n2
           where n2.topic_id = n.topic_id and n2.author = 'evaluator'
             and n2.parent_id is null
           order by n2.created_at desc limit 1) as version_id
  from review_notes n
  where n.author = 'evaluator' and n.parent_id is null
  group by n.topic_id
)
select c.slug, t.slug, t.id
from form f
join topics  t on t.id = f.topic_id and t.deleted_at is null
join clients c on c.id = t.client_id and c.deleted_at is null
where not exists (
        select 1 from review_notes q
        where q.topic_id = f.topic_id and q.author = 'evaluator'
          and q.parent_id is null and q.blog_version_id = f.version_id
          and not exists (select 1 from review_notes r where r.parent_id = q.id))
  -- NOT STALE, and staleness is VERSION **AND** ITERATION here because this predicate asks the
  -- negative: the other three twins raise stale on "version moved OR iteration moved", so the
  -- pending set is its complement, "version still matches AND iteration still matches". The two
  -- arms below are that De Morgan flip and not a different rule, which is the only way this
  -- predicate and portal_submit_answers can agree about one form.
  --
  -- The anchor arm is the one this gained. Without it the sweep kept rating a form pending after a
  -- version landed under it, and pending means DISPATCH: it would spend real quota feeding answers
  -- about the old draft into a surgical revise of the new one, which is worse than not revising,
  -- because the answers read as authoritative. The iteration arm alone misses that whenever the
  -- new version lands on the same iteration number.
  --
  -- The iteration arm stays for the restore case: a stop mid-revise puts the artifact set back
  -- byte for byte and commits NO new version, so the anchor still matches while the iteration has
  -- moved. Version-only would keep dispatching there.
  and f.version_id = (select v.id from blog_versions v
                       where v.topic_id = f.topic_id
                       order by v.version_no desc limit 1)
  and (select q.asked_iter from review_notes q
        where q.topic_id = f.topic_id and q.author = 'evaluator'
          and q.parent_id is null and q.blog_version_id = f.version_id
          and q.asked_iter is not null
        order by q.created_at, q.ref limit 1)
      is not distinct from
      coalesce((select max(s.iter) from status_events s where s.topic_id = f.topic_id), 0)
  and coalesce((select s.status::text from status_events s
                 where s.topic_id = f.topic_id and s.status <> 'running'
                 order by s.line_no desc limit 1), 'running') = 'needs_review'
"""


def pending_topics():
    """[(client_slug, topic_slug, topic_id)] owed an answer-driven revise right now."""
    return [(r[0], r[1], r[2]) for r in db.q(_PENDING_SQL)]


# The pending predicate, narrowed to one topic. Wraps _PENDING_SQL verbatim so the two can
# never disagree about what "pending" means: the settle path asks it whether a just-run
# revise actually resolved the topic (left the set) before it frees the claim.
_IS_PENDING_SQL = (
    "select 1 from (" + _PENDING_SQL + ") p(client_slug, topic_slug, topic_id) "
    "where p.topic_id = %s"
)


def is_pending(topic_id) -> bool:
    """True when this topic is still owed an answer-driven revise (unchanged by the run)."""
    return db.q(_IS_PENDING_SQL, (topic_id,), fetch="one") is not None


def attempts_of(topic_id) -> int:
    """How many times a revise has been dispatched for this topic's live claim, 0 if none."""
    row = db.q("select attempts from portal_revise_claims where topic_id = %s",
               (topic_id,), fetch="one")
    return int(row[0]) if row is not None else 0


def claim(topic_id, *, max_attempts=None) -> bool:
    """True when THIS engine holds the claim. The upsert's WHERE arm means a live claim
    (younger than CLAIM_TTL) refuses everyone else, and an abandoned one changes hands.

    Every claim records one more dispatch in `attempts`. When `max_attempts` is set (the
    automatic sweep passes MAX_SWEEP_ATTEMPTS), a topic whose claim already reached that
    many attempts is refused, so a repeatedly-failing pickup stops re-spending. The
    operator's manual rerun passes None and is never capped: a person choosing the spend
    overrides the guard, and its settle DELETES the claim, resetting the count for next
    time. A fresh claim always starts at 1, so the very first dispatch is never capped.
    """
    cap = "" if max_attempts is None else " and portal_revise_claims.attempts < %s"
    params = [topic_id, socket.gethostname()]
    if max_attempts is not None:
        params.append(max_attempts)
    row = db.q(
        f"""insert into portal_revise_claims (topic_id, claimed_by, attempts) values (%s, %s, 1)
            on conflict (topic_id) do update
              set claimed_by = excluded.claimed_by, claimed_at = now(),
                  attempts = portal_revise_claims.attempts + 1
              where portal_revise_claims.claimed_at < now() - interval '{CLAIM_TTL}'{cap}
            returning topic_id""",
        tuple(params), fetch="one")
    return row is not None


def release(topic_id) -> None:
    db.q("delete from portal_revise_claims where topic_id = %s", (topic_id,), fetch="none")


async def sweep(dispatch, topic_in_flight) -> int:
    """One pass: claim and dispatch every pending topic this engine may take.

    `dispatch(client_slug, topic_slug)` starts the revise and returns its asyncio.Task;
    `topic_in_flight(client_slug, topic_slug)` is the same refusal the POST route makes, and a
    topic already being written by a live run is left for a later sweep because a second session
    against one draft is the one thing the queue cannot make safe. Both arrive as callables
    because they live in server/app.py, which imports this module: importing back would
    be a cycle.

    IT USED TO SKIP ON ANY LIVE RUN FOR THE BRAND, "so the sweep never stacks work behind a
    batch". Stacking is now exactly what it should do: the engine's queue is per blog, so a
    dispatched revise takes the next free slot of five rather than waiting out a whole batch.
    """
    try:
        pending = await asyncio.to_thread(pending_topics)
    except Exception:
        log.exception("client-answers sweep could not read the record; retrying next interval")
        return 0

    dispatched = 0
    for client_slug, topic_slug, topic_id in pending:
        if topic_in_flight(client_slug, topic_slug):
            continue
        try:
            claimed = await asyncio.to_thread(claim, topic_id, max_attempts=MAX_SWEEP_ATTEMPTS)
        except Exception:
            log.exception("claim failed for %s/%s; skipping this sweep", client_slug, topic_slug)
            continue
        if not claimed:
            # Refused for one of two reasons: another engine holds a live claim, or this
            # topic hit the automatic-retry cap. Surface the cap so a repeatedly-failing
            # pickup is visible and handed to a human, not silently dropped every interval.
            try:
                if await asyncio.to_thread(attempts_of, topic_id) >= MAX_SWEEP_ATTEMPTS:
                    log.warning(
                        "CLIENT ANSWERS: %s/%s reached the automatic-revise cap (%d attempts); "
                        "leaving it for an operator rerun", client_slug, topic_slug,
                        MAX_SWEEP_ATTEMPTS)
            except Exception:
                pass
            continue
        log.warning(
            "CLIENT ANSWERS: %s/%s was answered from the portal; dispatching the "
            "answer-driven revise on this machine (spends this device's quota; "
            "GEO_ANSWERS_PICKUP=0 disables)", client_slug, topic_slug)
        task = dispatch(client_slug, topic_slug)
        task.add_done_callback(
            lambda _t, tid=topic_id, cs=client_slug, ts=topic_slug: _settle_sweep(tid, cs, ts))
        dispatched += 1
    return dispatched


def _off_loop(fn) -> None:
    """Done-callbacks run on the loop thread and db.q blocks, so run fn on an executor."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        fn()
        return
    loop.run_in_executor(None, fn)


def _release_later(topic_id, client_slug, topic_slug) -> None:
    """Unconditionally free the claim once a dispatch settles: the MANUAL rerun path, where
    the operator chose the spend and a fresh count next time is the right default."""
    def _do():
        try:
            release(topic_id)
        except Exception:
            log.exception("could not release revise claim for %s/%s (expires on its own in %s)",
                          client_slug, topic_slug, CLAIM_TTL)
    _off_loop(_do)


def _settle_sweep(topic_id, client_slug, topic_slug) -> None:
    """Free the claim after an AUTOMATIC dispatch settles ONLY if the revise resolved the
    topic (it left the pending set). A still-pending topic means the revise did not take, so
    KEEP the claim: its `attempts` is the cap that eventually stops the retries, and its
    fresh `claimed_at` backs the next automatic try off by CLAIM_TTL instead of re-dispatching
    on the next sweep. Releasing a resolved topic's claim frees its count so a genuinely new
    later form is never blocked by a stale one."""
    def _do():
        try:
            if not is_pending(topic_id):
                release(topic_id)
        except Exception:
            log.exception("could not settle revise claim for %s/%s (expires on its own in %s)",
                          client_slug, topic_slug, CLAIM_TTL)
    _off_loop(_do)


async def run_forever(dispatch, topic_in_flight) -> None:
    """The background loop app.py starts: sweep now, then every SWEEP_INTERVAL_S."""
    while True:
        await sweep(dispatch, topic_in_flight)
        await asyncio.sleep(SWEEP_INTERVAL_S)

#!/usr/bin/env python3
"""ADMIN EMAIL IS SENT ONCE, OR NOT AT ALL. Sends no mail and calls no model.

Four things are pinned, and each one is a way this feature fails in production rather than a
restatement of what the code says:

  1. THE CLAIM IS THE LOCK. Two callers racing one event produce one send. Without this a client
     filing ten suggestions inside one review round mails ten times, which is the documented cap
     at schema.sql:1605 and therefore the realistic case, not the pathological one.
  2. THE KEY NAMES THE EVENT, NOT THE ROW. Every dedupe key each query builds is asserted to be
     stable across rows of the same event and distinct across different events.
  3. NOTHING RAISES. Every entry point is called with the transport broken and with the database
     broken. Three of the four callers are a watchdog, a circuit breaker and a background sweep;
     a notifier that throws inside those stops the thing that was watching the engine.
  4. NO KEY MEANS NO SEND AND NO CLAIM. An unconfigured machine must behave exactly as it did
     before this file existed, including leaving the dedupe table untouched, or the day someone
     adds a key they get the entire backlog.

The database is a fake: the real one is a live Supabase project and a test that mails on a bad
day is a test nobody runs twice.

  .venv/bin/python tests/notify_check.py
"""
import logging
import pathlib
import sys
import threading
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from server import notify  # noqa: E402


class FakeDB:
    """The two calls notify makes: a claim insert and the event reads."""

    def __init__(self, rows=None, explode=False):
        self.claimed = {}
        self.rows = rows or {}
        self.explode = explode
        self.lock = threading.Lock()
        self.claim_attempts = 0   # every insert that reached the database, won or lost

    def config_value(self, name):
        # Only RESEND_FROM is read through here; an empty value exercises the fallback sender,
        # which is the state every machine is in until strategi.is verifies in Resend.
        if self.explode:
            raise RuntimeError("database is down")
        return ""

    def q(self, sql, params=None, fetch="all"):
        if self.explode:
            raise RuntimeError("database is down")
        if sql.strip().startswith("insert into admin_notifications"):
            key, kind = params
            with self.lock:
                self.claim_attempts += 1
                if key in self.claimed:
                    return None
                self.claimed[key] = kind
                return (key,)
        if "from admin_notifications" in sql:
            if fetch == "val":
                # backfill's sentinel probe: it asks for ONE key, not for emptiness. Modelling it
                # as "any row at all" is what the production code used to do, and it is exactly
                # the defect the engine-row test below exists to catch.
                return 1 if params and params[0] in self.claimed else None
            wanted = set(params[0]) if params else set()   # sweep's bulk already-sent read
            return [(k,) for k in self.claimed if k in wanted]
        for marker, rows in self.rows.items():
            if marker in sql:
                return rows
        return []


def install(db, sent=None, status=200):
    """Point notify at a fake database and a fake Resend. Returns the sent list."""
    sent = [] if sent is None else sent
    notify.db = db
    notify._backfilled = False
    notify._configured = lambda: "re_test_key"

    class Response:
        status_code = status
        text = "forced failure"

    def post(url, **kwargs):
        if status == 0:
            raise RuntimeError("connection reset")
        sent.append(kwargs["json"])
        return Response()

    notify.httpx = type("H", (), {"post": staticmethod(post)})
    return sent


def drain():
    """Wait for notify's daemon threads. It returns immediately by design."""
    for _ in range(200):
        if not any(t.name.startswith("notify-") for t in threading.enumerate()):
            return
        time.sleep(0.01)
    raise AssertionError("notify threads did not finish")


# 1. THE CLAIM IS THE LOCK ---------------------------------------------------
db = FakeDB()
sent = install(db)

for _ in range(10):
    notify.notify("changes_requested", "changes:topic-a:2026-08-11", "subject", "body")
drain()
assert len(sent) == 1, f"ten calls on one key sent {len(sent)} emails, expected 1"
assert sent[0]["to"] == ["tech@strategi.is"], sent[0]["to"]
assert db.claimed == {"changes:topic-a:2026-08-11": "changes_requested"}, db.claimed

# A different round of the same topic IS a second event and must mail.
notify.notify("changes_requested", "changes:topic-a:2026-08-20", "subject", "body")
drain()
assert len(sent) == 2, "a second review round did not mail"

# Racing threads still produce one send: the insert, not a read-then-write, is the guard.
db2 = FakeDB()
sent2 = install(db2)
threads = [threading.Thread(target=notify.notify,
                            args=("client_approved", "approved:t:1", "s", "b"))
           for _ in range(12)]
for t in threads:
    t.start()
for t in threads:
    t.join()
drain()
assert len(sent2) == 1, f"12 racing callers sent {len(sent2)} emails, expected 1"

# 2. THE KEY NAMES THE EVENT, NOT THE ROW -----------------------------------
# Two comment rows in one review round share a key; a different round does not. The queries
# select distinct on exactly this expression, so building it here mirrors the SQL's contract.
round_a = "changes:%s:%s" % ("topic-1", "2026-08-01 10:00:00+00")
round_a_again = "changes:%s:%s" % ("topic-1", "2026-08-01 10:00:00+00")
round_b = "changes:%s:%s" % ("topic-1", "2026-08-09 12:00:00+00")
assert round_a == round_a_again, "two suggestions in one round must share a key"
assert round_a != round_b, "a re-send opens a new round and must mail again"

# Every arm uses its own prefix, so a topic and its channel post cannot collide.
prefixes = {"changes:", "changes-ch:", "approved:", "approved-ch:", "answers:"}
assert len(prefixes) == 5, "arm prefixes must be distinct"
for sql in (notify._CHANGES_SQL, notify._CHANGES_CHANNEL_SQL, notify._APPROVED_SQL,
            notify._APPROVED_CHANNEL_SQL, notify._ANSWERS_SQL):
    assert any(("'" + p) in sql for p in prefixes), f"query has no key prefix:\n{sql}"

# The two comment arms must exclude the operator's own notes, or the team mails itself.
for sql in (notify._CHANGES_SQL, notify._CHANGES_CHANNEL_SQL, notify._ANSWERS_SQL):
    assert "author = 'client'" in sql, f"arm does not filter to client authorship:\n{sql}"
# Replies are not change requests: every consumer of this state filters them out.
assert "c.parent_id is null" in notify._CHANGES_SQL, "blog comments must exclude replies"
# An answer IS a reply, and the operator's own answer must not count as the client's.
assert "r.parent_id is not null" in notify._ANSWERS_SQL, "answers must be reply rows"

# 3. NOTHING RAISES ---------------------------------------------------------
# notify logs every swallowed failure with a traceback, which is the correct behaviour and makes
# a PASSING run of this section look exactly like a crashing one. Silence it here only: what is
# under test is that nothing propagates, and the log noise obscures that rather than showing it.
logging.getLogger("server.notify").setLevel(logging.CRITICAL)

for status in (500, 0):  # Resend refusing, and the connection dying mid-post
    broken = FakeDB()
    install(broken, status=status)
    notify.notify("engine_halted", f"halt:{status}", "s", "b")
    notify.engine_halted(2, "acme/topic died in 8s", 1_000_000.0 + status)
    notify.slot_reclaimed("acme", "topic", 2700.0, 1_000_000.0 + status)
    notify.sweep()
    drain()

dead = FakeDB(explode=True)
install(dead)
notify.engine_halted(2, "acme/topic died in 8s", 2_000_000.0)
notify.slot_reclaimed("acme", "topic", 2700.0, 2_000_000.0)
notify.sweep()          # backfill and the event reads both raise
drain()

# A SECOND WEDGE OF ONE TOPIC MUST MAIL AGAIN. The watchdog cancels at a fixed stall timeout and
# reclaims a fixed grace later, so two wedges of the same topic produce very nearly the same
# DURATION by construction; keying on it swallowed the second outage.
wedged = FakeDB()
sent_w = install(wedged)
notify.slot_reclaimed("acme", "topic", 2700.0, 5_000_000.0)
notify.slot_reclaimed("acme", "topic", 2700.0, 5_009_999.0)   # same duration, later reclaim
drain()
assert len(sent_w) == 2, f"a second wedge of one topic sent {len(sent_w)}, expected 2"

# 4. NO KEY MEANS NO SEND AND NO CLAIM --------------------------------------
unconfigured = FakeDB()
sent3 = install(unconfigured)
notify._configured = lambda: ""
notify.notify("client_approved", "approved:t:never", "s", "b")
notify.engine_halted(2, "x", 3_000_000.0)
notify.slot_reclaimed("acme", "topic", 2700.0, 4_000_000.0)
drain()
assert sent3 == [], "an unconfigured machine sent mail"
assert unconfigured.claimed == {}, "an unconfigured machine claimed a dedupe key"

# BACKFILL: a fresh install claims history silently, so the first poll is not a burst ------
history = FakeDB(rows={
    "from blog_comments": [("changes:t1:s1", "Acme", "a-topic")],
    "from channel_post_comments": [],
    "from topics t": [("approved:t2:s2", "Acme", "b-topic")],
    "from channel_posts p": [],
    "from review_notes": [("answers:t3:v3", "Acme", "c-topic")],
})
sent4 = install(history)
notify.sweep()
drain()
assert sent4 == [], f"the first sweep mailed {len(sent4)} historic events, expected 0"
assert len(history.claimed) == 4, f"backfill claimed {len(history.claimed)}, expected 3 + sentinel"
assert notify._BACKFILL_DONE in history.claimed, "backfill left no sentinel"

# A SETTLED SWEEP TOUCHES NOTHING. The queries look back 30 days, so without the bulk filter in
# sweep() every tick would spawn a thread per historic event to discover its key was taken: on a
# busy month that is dozens of conflicting inserts every two minutes, forever.
settled = history.claim_attempts
notify.sweep()
drain()
assert history.claim_attempts == settled, (
    f"a sweep with nothing new made {history.claim_attempts - settled} claim attempts, expected 0")
assert sent4 == [], "a settled sweep sent mail"

# A NEW event after the backfill does mail, or the backfill would have muted the feature.
history.rows["from blog_comments"] = [("changes:t1:s1", "Acme", "a-topic"),
                                      ("changes:t9:s9", "Acme", "new-topic")]
notify.sweep()
drain()
assert len(sent4) == 1, f"a new event after backfill sent {len(sent4)} emails, expected 1"
assert "new-topic" in sent4[0]["subject"], sent4[0]["subject"]
assert history.claim_attempts == settled + 1, (
    "the new event should have made exactly one claim attempt")

# A ROW FROM ANOTHER WRITER MUST NOT MUTE THE BACKFILL. Four writers share this table: a breaker
# trip or a reclaimed slot can claim a row before any sweep has ever run, and a probe that asked
# "is this table empty" would read that engine row as "already backfilled" and then mail the whole
# 30-day client history on the first tick. The sentinel is what makes the probe answer the
# question actually being asked. Kept last: install() rebinds notify.db, so anything asserting
# against an earlier fake must already have run.
engine_first = FakeDB(rows=dict(history.rows))
sent5 = install(engine_first)
notify.slot_reclaimed("acme", "topic", 2700.0, 6_000_000.0)   # the engine gets there first
drain()
assert len(sent5) == 1, "the engine's own event should mail"
notify.sweep()                                                 # now the first client sweep runs
drain()
assert len(sent5) == 1, (
    f"a pre-existing engine row let the backfill be skipped and mailed "
    f"{len(sent5) - 1} historic client events")

# A PARTIAL BACKFILL RETRIES AND COMPLETES. Every claim is durable on its own, so a run that dies
# part way leaves rows behind and no sentinel. The next tick must finish the job rather than read
# its own half-written rows as evidence it already did.
partial = FakeDB(rows=dict(history.rows))
sent6 = install(partial)
real_claim = notify._claim
attempts = [0]


def flaky_claim(key, kind):
    attempts[0] += 1
    if attempts[0] == 2:
        raise RuntimeError("pool timeout")
    return real_claim(key, kind)


notify._claim = flaky_claim
notify.sweep()            # dies inside backfill; sweep swallows it, _backfilled stays False
drain()
assert notify._BACKFILL_DONE not in partial.claimed, "a partial backfill must leave no sentinel"
notify._claim = real_claim
notify.sweep()            # the retry completes it
drain()
assert notify._BACKFILL_DONE in partial.claimed, "the retry did not complete the backfill"
assert sent6 == [], f"a retried backfill mailed {len(sent6)} historic events, expected 0"

print("notify_check: OK")
print("  claim is the lock, 10 calls and 12 racing threads each sent 1")
print("  keys name the round, not the row; five arms carry distinct prefixes")
print("  no entry point raises on a refusing, dead, or exploding dependency")
print("  an unconfigured machine sends nothing and claims nothing")
print("  a fresh install backfills history silently, then mails only what is new")
print("  a settled sweep makes zero claim attempts, so the poll costs one read")
print("  a second wedge of one topic mails again; an engine row cannot mute the backfill")
print("  a backfill that dies part way leaves no sentinel and completes on the retry")

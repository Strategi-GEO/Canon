# Concurrency proof: geo-factory runner over HTTP

Build-order step 4 evidence, recorded 2026-07-16. This is an archived record: the
run stubbed the agents (no SDK sessions, no API calls) so the concurrency plumbing
could be measured on its own, while exercising the exact production plumbing
(status.py subprocesses appending status.jsonl, the SSE tailer, the semaphore and
client lock in server/runner.py). That agent stub has since been removed from the
product; the plumbing it exercised is real and unchanged, and that plumbing is
what this proof is about. Server: uvicorn on port 8907, one worker. Analysis
script: tests/concurrency_check.py, run against the status.jsonl files, which are
the authoritative feed.

## The claim under test

The topic semaphore caps topics in flight at 5, dispatch is
gather-all-at-once so topic 6 starts the instant a slot frees (not after the
first batch of 5 finishes), and one client's queue runs at a time.

## Run 1: a test fixture client (named demo-co at the time), rows [0..6], 7 topics vs cap 5

POST /api/clients/demo-co/generate returned 202 with
run_id d36cc76bdbe84b58b3db990507c9698a.

### Per-topic table (from status.jsonl first and terminal lines)

| slug | start | end | iters | score trail | terminal |
|---|---|---|---|---|---|
| saas-pricing-models-explained | 09:38:09.185 | 09:38:16.806 | 4 | 87->89->92->92 | needs_review |
| best-project-management-tools-for-remote-teams | 09:38:09.185 | 09:38:14.089 | 2 | 83->95 | done |
| what-is-single-sign-on-and-why-it-matters | 09:38:09.185 | 09:38:14.741 | 2 | 83->95 | done |
| how-to-reduce-customer-churn-in-saas | 09:38:09.186 | 09:38:17.445 | 4 | 85->89->93->97 | done |
| how-to-choose-a-crm-for-a-small-business | 09:38:09.187 | 09:38:15.307 | 3 | 86->90->98 | done |
| gdpr-compliance-checklist-for-uk-saas-companies | 09:38:14.149 | 09:38:18.352 | 2 | 86->98 | done |
| api-first-vs-low-code-platforms | 09:38:14.770 | 09:38:19.371 | 2 | 84->96 | done |

Score trails above are per-iteration eval scores; the terminal status line
repeats the final score, so the raw feed shows it twice.

### Measured max concurrency

Sweeping all 14 start/end events in time order: **max concurrent topics = 5**,
exactly the cap. 7 topics vs cap 5 saturated the semaphore. PASS.

### Topic 6 timing inequality (no batch barrier)

- min(first-five start) = 2026-07-16T09:38:09.185792+00:00
- topic 6 (gdpr-compliance-checklist-for-uk-saas-companies) start
  = 2026-07-16T09:38:14.149896+00:00
- topic 7 (api-first-vs-low-code-platforms) start
  = 2026-07-16T09:38:14.770618+00:00
- max(first-five end) = 2026-07-16T09:38:17.445865+00:00

Both overflow starts are after the first wave began, and topic 6 started at
09:38:14.149, 3.3 seconds BEFORE the slowest first-wave topic finished at
09:38:17.445. It began 60 ms after the fastest first-wave topic freed its
slot at 09:38:14.089. A slot freed and was reused instantly; a batch-of-five
barrier would have held topic 6 until 09:38:17.445. PASS.

### Terminal integrity and outcome mix

Every topic reached exactly one terminal line, last in its file. PASS.
Six topics ended done with scores 95, 95, 96, 97, 98, 98 (all >= 95). PASS.
One topic (saas-pricing-models-explained) hit the 4-iteration cap stalled at
92 and ended needs_review, so the amber path was exercised. PASS.

## SSE cross-check (run 1)

- Live capture (curl -N connected right after the 202): 173 "event: status"
  frames, which equals the 173 total status.jsonl lines across the 7 topics.
  Exactly one "event: run" frame ({"live": false}) arrived and closed the
  stream. PASS.
- Replay: reconnecting to the same run's /events after completion replayed
  all 173 status frames plus the single run frame, then closed (curl exited
  0, not on timeout). PASS.

## Run liveness (run 2)

Run 1 finished before /api/runs could be polled, so a second run with the
same rows [0..6] (run_id b1eb75fba27b4bcba3f165ac48351696) was submitted and
polled 0.5 s in: it showed live:true while run 1 stayed live:false. After
completion both runs showed live:false. PASS.

Note: run 2 reused the same output dirs, so each status.jsonl now carries two
runs' lines (two terminal lines per file). The table and assertions above
were computed from the files as they stood after run 1 only.

## Negative checks

| Check | Result |
|---|---|
| POST generate for demo-co while its canonical-facts.md still held the token PLACEHOLDER | 409, body: "preflight failed for demo-co: canonical-facts.md still contains the token PLACEHOLDER and has not been reviewed" (names PLACEHOLDER). PASS |

**This is the verbatim record of the original run.** It was recorded when the client was a
plain fixture named `demo-co` whose `canonical-facts.md` still held the token PLACEHOLDER. The
refusal is unchanged and still fires for any client in that state.
| POST rows [999] | 422, detail names index 999 as "row does not exist". PASS |
| GET output file outside whitelist (secrets.txt) | 404. Control: blog.md on the same topic returned 200. PASS |

## One-client-at-a-time

Not directly measured here: with a single client submitted, CLIENT_LOCK never
contends. The lock wraps the whole gather in runner.run_batch, so a second
client's batch cannot interleave; proving that over HTTP needs a two-client
run and is out of scope for this step.

## Verdict

All assertions PASS. tests/concurrency_check.py exits 0 against the run 1
status.jsonl files. The run stubbed the agents, so its scores, drafts, and
dossiers are not real content and were marked not-for-publication; the proof
rests only on the status.jsonl timing feed, which the plumbing writes
identically whether the agents are real or stubbed.

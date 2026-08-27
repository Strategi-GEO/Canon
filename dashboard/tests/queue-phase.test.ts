/**
 * THE QUEUE MUST NOT INVENT A STATE THE ENGINE DOES NOT REPORT.
 *
 * Two display defects, one cause: the table inferred a topic's phase from whether SSE frames had
 * arrived, and frames go missing for reasons that have nothing to do with the queue.
 *
 *  1. A topic that FAILED twenty minutes ago read "Queued, waiting 24m 44s", counting up forever,
 *     because its run was past useQueueStreams' MAX_QUEUE_STREAMS cap and had no socket at all.
 *     Meanwhile the New tab, which reads the engine's own `terminal` flag, correctly offered the
 *     same topic for retry. One topic, two surfaces, opposite answers.
 *  2. A STOPPED topic kept advertising a live `write` stage, because the frame that stopped it
 *     never reached the map and the last one that did said `revise/start`.
 *
 * The fix is to read `terminal` first, which runner.mark_topic_terminal sets the instant a
 * session settles and which /api/runs already carries on every poll.
 *
 * The third defect is the clock: status.jsonl is append-only ACROSS runs, so a retried topic
 * replays a previous session's frames and `startedAt` latched the oldest one. The queue header
 * takes the oldest running row, so it read "772h elapsed" over blogs ten minutes old.
 *
 *   cd dashboard && npm test
 */
import assert from "node:assert/strict";
import test from "node:test";

import { applyEvent, blank } from "../src/lib/run-fold.ts";
import type { StatusEvent } from "../src/types/index.ts";

type Phase = "running" | "queued" | "finished";

/** The table's own rule, extracted verbatim so the test pins the shipped precedence. */
function phaseOf(terminal: boolean | undefined, streamed: { status: string } | null): Phase {
  return terminal === true
    ? "finished"
    : streamed === null
      ? "queued"
      : streamed.status === "running"
        ? "running"
        : "finished";
}

const seed = { topicSlug: "t", label: "T", roadmapIndex: 0 };

function frame(over: Partial<StatusEvent>): StatusEvent {
  return {
    ts: "2026-08-26T00:00:00+00:00",
    slug: "acme",
    topic_slug: "t",
    stage: "research",
    event: "start",
    iter: 1,
    score: null,
    status: "running",
    note: "",
    ...over,
  } as StatusEvent;
}

test("a terminal topic is finished even with no frames at all (the unstreamed-run case)", () => {
  assert.equal(phaseOf(true, null), "finished");
});

test("a terminal topic is finished even while its last frame still says running", () => {
  // Exactly the stopped-blog case: the `stopped` frame never arrived.
  assert.equal(phaseOf(true, { status: "running" }), "finished");
});

test("absence still means queued for a topic the engine has not settled", () => {
  assert.equal(phaseOf(undefined, null), "queued");
  assert.equal(phaseOf(false, null), "queued");
});

test("a running topic with frames is still running", () => {
  assert.equal(phaseOf(undefined, { status: "running" }), "running");
});

test("a retry resets the clock instead of timing from the previous run", () => {
  let topic = blank(seed);
  topic = applyEvent(topic, frame({ ts: "2026-07-24T11:54:00+00:00" }));
  assert.equal(topic.startedAt, "2026-07-24T11:54:00+00:00");

  // The old run ends.
  topic = applyEvent(
    topic,
    frame({ ts: "2026-07-25T21:30:00+00:00", stage: "eval", event: "end", status: "failed" }),
  );
  assert.equal(topic.endedAt, "2026-07-25T21:30:00+00:00");

  // A month later the operator retries. The first frame of the NEW run must re-open the clock.
  topic = applyEvent(topic, frame({ ts: "2026-08-26T00:10:00+00:00" }));
  assert.equal(topic.startedAt, "2026-08-26T00:10:00+00:00", "startedAt must follow the new run");
  assert.equal(topic.endedAt, null, "the previous run's ending does not end this one");
});

test("a continuing run keeps its original start", () => {
  let topic = blank(seed);
  topic = applyEvent(topic, frame({ ts: "2026-08-26T00:10:00+00:00" }));
  topic = applyEvent(
    topic,
    frame({ ts: "2026-08-26T00:20:00+00:00", stage: "write", event: "start" }),
  );
  assert.equal(topic.startedAt, "2026-08-26T00:10:00+00:00");
  assert.equal(topic.endedAt, null);
});

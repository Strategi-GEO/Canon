/**
 * THE PURE FOLD BEHIND THE RUN VIEWS: what one status frame does to one topic's state.
 *
 * Split out of components/create/use-run-stream.ts for the reason tests/blog-state.test.ts gives
 * about its own subject: a module worth pinning must import nothing but what it tests. That file
 * pulls in React, `@/lib/api` and `@/lib/hosted`, none of which `node --test` can resolve, and
 * .github/workflows/tests.yml deliberately relies on Node stripping the types itself rather than
 * on a runner that could. So the fold could not be checked at all, and the fold is the part worth
 * checking: every defect this logic has carried lived here, never in the socket.
 *
 * Type-only imports are erased before resolution, so they cost the test nothing.
 */
import type { RunStatus, StatusEvent } from "@/types";

/**
 * The five segments an operator watches. "revise" is deliberately absent: it is not a sixth
 * stage, it is the write stage running again, so it folds onto WRITE and resets what follows.
 */
export const SEGMENTS = ["research", "write", "gates", "links", "eval"] as const;

export type Segment = (typeof SEGMENTS)[number];

export type SegState = "pending" | "active" | "done";

/** One topic the run was accepted for, named before its first frame ever arrives. */
export type Seed = {
  topicSlug: string;
  label: string;
  /**
   * Its row on the sheet ON SCREEN, or null when it is on no row there.
   *
   * Taken from the matched RoadmapRow and NEVER from the accepted topic's own index, for the
   * reason seedsFor spells out below: the run's index points into the sheet the run STARTED
   * from, which after any refresh is not the sheet being displayed. A number is a promise that
   * it agrees with the roadmap the operator is looking at, and only the matched row can keep it.
   */
  roadmapIndex: number | null;
};

/**
 * The statuses the engine treats as terminal. A topic in one of these is finished for good.
 *
 * "stopped" belongs here for the same reason the other three do: the engine will do no more work
 * on that topic. Leaving it out would tick a live elapsed clock forever on a topic the operator
 * halted, because `endedAt` is set from this set and nothing else freezes the reading.
 */
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "done",
  "needs_review",
  "failed",
  "stopped",
]);

export type TopicRun = {
  topicSlug: string;
  label: string;
  /** This topic's row on the sheet on screen, or null. Carried from its Seed. See Seed. */
  roadmapIndex: number | null;
  segments: Record<Segment, SegState>;
  /**
   * Keyed by iteration, not appended, because the lead's terminal line repeats the final
   * eval score. Appending would render a phantom chip: 88 -> 96 -> 96.
   */
  scores: Map<number, number>;
  iter: number;
  status: RunStatus;
  /**
   * On a `failed` topic: did the run reach a verdict, or none at all? The live card needs the
   * same split the library shows, because "failed after 4m" and "did not finish after 8s" are
   * different events and the second is the one the operator watches for during a quota storm.
   */
  died: boolean;
  note: string;
  /** False until a frame names this topic, which is how a queued topic reads as queued. */
  started: boolean;
  /**
   * Every timestamp below is the ENGINE's own `ts`, never the moment this browser received
   * the frame. The engine runs on the operator's machine, so its clock is this clock and the
   * two cannot skew; and reading time off the frame means a reconnect that replays history
   * rebuilds the same timings rather than restarting every clock at the moment of reattach.
   */

  /** `ts` of this topic's first frame, so elapsed measures work and not queue time. */
  startedAt: string | null;
  /** `ts` of the last stage `start` frame. The stage clock, which is what answers "stuck?". */
  stageSince: string | null;
  /** `ts` of the terminal frame, so a finished topic's elapsed freezes instead of ticking. */
  endedAt: string | null;
  /**
   * The last stage to open, held separately from `segments` because between a stage's `end`
   * frame and the next stage's `start` frame nothing is active. Deriving the label from
   * `segments` alone would blank the stage name for that gap and read as a stall.
   */
  stage: Segment | null;
};

export function blank(seed: Seed): TopicRun {
  return {
    topicSlug: seed.topicSlug,
    label: seed.label,
    roadmapIndex: seed.roadmapIndex,
    segments: {
      research: "pending",
      write: "pending",
      gates: "pending",
      links: "pending",
      eval: "pending",
    },
    scores: new Map(),
    iter: 1,
    status: "running",
    died: false,
    note: "",
    started: false,
    startedAt: null,
    stageSince: null,
    endedAt: null,
    stage: null,
  };
}

function isSegment(value: string): value is Segment {
  return (SEGMENTS as readonly string[]).includes(value);
}

export function applyEvent(topic: TopicRun, e: StatusEvent): TopicRun {
  const segments = { ...topic.segments };
  const seg = e.stage === "revise" ? "write" : isSegment(e.stage) ? e.stage : null;

  if (seg) {
    if (seg === "write" && e.event === "start") {
      // A revise genuinely re-runs gates, links and eval, so leaving them filled would show
      // work that is happening again as work already finished.
      segments.gates = "pending";
      segments.links = "pending";
      segments.eval = "pending";
    }
    segments[seg] = e.event === "start" ? "active" : "done";
  }

  const scores = new Map(topic.scores);
  if (e.score !== null) {
    scores.set(e.iter, e.score);
  }

  const opening = seg !== null && e.event === "start";
  const terminal = TERMINAL.has(e.status);

  /**
   * A NON-TERMINAL FRAME ARRIVING AFTER A TERMINAL ONE IS A NEW RUN, and the clocks must say so.
   *
   * status.jsonl is append-only ACROSS runs, so a retried topic replays its whole history: the
   * previous run's frames, its terminal line, and then this run's. Latching `startedAt` from the
   * first frame ever seen therefore timed the topic from a session that ended weeks ago, and the
   * queue header, which takes the oldest running row, read `772h elapsed` over blogs that had
   * been running for ten minutes.
   *
   * This is the same rule `died` states below: a topic that dies, is retried and then reaches a
   * verdict must not keep the older frame's answer. `endedAt` clears with it, because the
   * previous run's ending does not end this one.
   */
  const restarted = topic.endedAt !== null && !terminal;

  return {
    ...topic,
    segments,
    scores,
    iter: Math.max(topic.iter, e.iter),
    // Terminal state is the status field, never the stage: the loop can revisit any stage,
    // so a stage name says nothing about being finished.
    status: e.status,
    // LATCHED FROM THIS FRAME AND NOT ACCUMULATED. The flag describes the terminal line, and a
    // topic that dies, is retried and then reaches a verdict must not keep the older frame's
    // answer: every frame overwrites it, exactly as `status` above does.
    died: e.died === true,
    note: e.note !== "" ? e.note : topic.note,
    started: true,
    startedAt: restarted ? e.ts : (topic.startedAt ?? e.ts),
    // Only a `start` frame opens a stage, so only a `start` frame resets the stage clock. A
    // revise re-opening `write` restarts it, which is correct: that stage is genuinely
    // beginning again rather than continuing.
    stageSince: opening ? e.ts : topic.stageSince,
    stage: opening ? seg : topic.stage,
    endedAt: terminal ? e.ts : restarted ? null : topic.endedAt,
  };
}

"use client";

import * as React from "react";
import { api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import type { RoadmapRow, RunStatus, StatusEvent } from "@/types";

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

/** What the engine actually puts in the topics array of a 202 and of the run list. */
type AcceptedTopic = {
  index?: number;
  topic_slug?: string;
  topic?: string;
};

/**
 * Names the topics a run was accepted for, so a queued topic reads as queued before its
 * first frame exists.
 *
 * This is a boundary, so it trusts the wire over the declared type. The engine sends topics
 * as objects carrying index and topic_slug, while the shared GenerateAccepted type calls
 * them string[]; both are handled here rather than betting on either. The row index is the
 * best match available: it yields the operator's own H1 for the label and the exact slug the
 * SSE frames are keyed by. An entry that resolves to no slug is dropped, because a seed
 * without a slug can never match a frame and would sit queued forever.
 */
export function seedsFor(topics: readonly unknown[], rows: RoadmapRow[]): Seed[] {
  return topics.flatMap((entry): Seed[] => {
    if (typeof entry === "string") {
      const row = rows.find((r) => r.topic === entry || r.topic_slug === entry);
      if (row) {
        return [{ topicSlug: row.topic_slug, label: row.topic, roadmapIndex: row.index }];
      }
      // No roadmap match: fall back to the documented slug rule, lowercase with spaces to
      // hyphens. A wrong guess only leaves the row queued until its first frame arrives.
      // No row means no number: there is nothing on screen for one to point at.
      return [
        {
          topicSlug: entry.toLowerCase().replace(/\s+/g, "-"),
          label: entry,
          roadmapIndex: null,
        },
      ];
    }

    if (entry && typeof entry === "object") {
      const topic = entry as AcceptedTopic;
      // Matched on topic_slug ONLY, never on index.
      //
      // An index means something only inside the sheet it came from, and the sheet on screen
      // is frequently NOT the sheet the run started from. An upload is transient by design
      // (roadmap.py save_upload archives it and deliberately does not overwrite the client's
      // roadmap.csv), so on the Overview, and on the create page after any refresh, these rows
      // are the client's SAVED roadmap while the run's indices point into the uploaded CSV.
      //
      // Matching across those two by index does not merely mislabel: it hands the seed a slug
      // belonging to some unrelated topic, so the frames the engine sends under the REAL slug
      // match no seed and mint a row of their own. Every topic then renders twice, once queued
      // under a borrowed name and once running under its own, and a three topic run reports
      // six blogs. A slug is the same string in both sheets or in neither, so it cannot half
      // match, which is exactly the property this needs.
      const row = rows.find((r) => r.topic_slug === topic.topic_slug);
      const topicSlug = row?.topic_slug ?? topic.topic_slug;
      if (!topicSlug) {
        return [];
      }
      // The NUMBER comes from the matched row for the same reason the SLUG does, and the
      // paragraph above is the whole argument: topic.index points into the sheet the run
      // started from. Reading it here would print a confident number from a different sheet,
      // which is worse than the mislabelling described above, because a wrong label looks
      // wrong on sight and a wrong number does not.
      return [
        {
          topicSlug,
          label: row?.topic ?? topic.topic ?? topicSlug,
          roadmapIndex: row?.index ?? null,
        },
      ];
    }

    return [];
  });
}

function blank(seed: Seed): TopicRun {
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

function applyEvent(topic: TopicRun, e: StatusEvent): TopicRun {
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

  return {
    ...topic,
    segments,
    scores,
    iter: Math.max(topic.iter, e.iter),
    // Terminal state is the status field, never the stage: the loop can revisit any stage,
    // so a stage name says nothing about being finished.
    status: e.status,
    note: e.note !== "" ? e.note : topic.note,
    started: true,
    startedAt: topic.startedAt ?? e.ts,
    // Only a `start` frame opens a stage, so only a `start` frame resets the stage clock. A
    // revise re-opening `write` restarts it, which is correct: that stage is genuinely
    // beginning again rather than continuing.
    stageSince: opening ? e.ts : topic.stageSince,
    stage: opening ? seg : topic.stage,
    endedAt: terminal ? e.ts : topic.endedAt,
  };
}

export type StreamState = {
  topics: TopicRun[];
  finished: boolean;
  reconnecting: boolean;
};

/**
 * Attaches to a run's SSE feed. The engine replays every historical frame on connect, so a
 * reconnect is idempotent as long as we dedupe by raw line content, which is what seen holds.
 *
 * The stream is held ABOVE both views rather than inside the live view, because the roadmap
 * table needs it too: an in flight topic has to read as yellow on the roadmap, and it must be
 * true on first paint after a refresh rather than only once a frame arrives. So runId is
 * nullable (no run means no subscription) and the reset below replaces the `key={runId}`
 * remount the live view used to rely on.
 */
export function useRunStream(runId: string | null, seeds: Seed[]): StreamState {
  const [state, setState] = React.useState(() => ({
    runId,
    topics: seeds.map(blank),
    finished: false,
    reconnecting: false,
  }));

  // A new run is a new set of topics, and last run's frames describe none of them. Adjusting
  // state during render is React's own answer to a prop change that invalidates state: it
  // re-renders before committing, so no stale run is ever painted. An effect would paint the
  // old run's topics under the new run id for a frame first.
  if (state.runId !== runId) {
    setState({ runId, topics: seeds.map(blank), finished: false, reconnecting: false });
  }

  const setTopics = React.useCallback((update: (current: TopicRun[]) => TopicRun[]) => {
    setState((current) => ({ ...current, topics: update(current.topics) }));
  }, []);
  const setFinished = React.useCallback((value: boolean) => {
    setState((current) => ({ ...current, finished: value }));
  }, []);
  const setReconnecting = React.useCallback((value: boolean) => {
    setState((current) => ({ ...current, reconnecting: value }));
  }, []);

  React.useEffect(() => {
    // Hosted mode has no SSE endpoint to stream from (runs are engine state, and there is
    // no engine), so the connection is never opened there. The create surface that mounts
    // this hook is gated off in hosted mode anyway; this is the belt to that braces.
    if (runId === null || HOSTED_READONLY) {
      return;
    }

    const seen = new Set<string>();
    const source = new EventSource(api.eventsUrl(runId));

    function onStatus(message: MessageEvent<string>) {
      if (seen.has(message.data)) {
        return;
      }
      seen.add(message.data);

      let e: StatusEvent;
      try {
        e = JSON.parse(message.data) as StatusEvent;
      } catch {
        return;
      }

      setReconnecting(false);
      setTopics((current) => {
        const i = current.findIndex((t) => t.topicSlug === e.topic_slug);
        if (i === -1) {
          // A frame for a topic no seed named. The engine is the authority on what is
          // running, so show it rather than drop it. It gets no number: a frame carries a slug
          // and nothing else, and no seed claimed it, so there is no row to read one from.
          return [
            ...current,
            applyEvent(
              blank({ topicSlug: e.topic_slug, label: e.topic_slug, roadmapIndex: null }),
              e,
            ),
          ];
        }
        const next = [...current];
        next[i] = applyEvent(next[i], e);
        return next;
      });
    }

    function onRun(message: MessageEvent<string>) {
      let e: { live: boolean };
      try {
        e = JSON.parse(message.data) as { live: boolean };
      } catch {
        return;
      }
      if (!e.live) {
        setFinished(true);
        setReconnecting(false);
        source.close();
      }
    }

    function onOpen() {
      setReconnecting(false);
    }

    function onError() {
      // EventSource retries on its own, and the engine replays all history on connect, so
      // nothing is lost. A quiet note beats an error an operator cannot act on. The run
      // itself is unaffected either way: it lives in the server, not in this tab.
      setReconnecting(true);
    }

    source.addEventListener("status", onStatus);
    source.addEventListener("run", onRun);
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);

    return () => {
      source.removeEventListener("status", onStatus);
      source.removeEventListener("run", onRun);
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.close();
    };
  }, [runId, setTopics, setFinished, setReconnecting]);

  return { topics: state.topics, finished: state.finished, reconnecting: state.reconnecting };
}

/**
 * Counts for the closing summary and the live header. Derived from status, never from the
 * stage reached.
 *
 * `queued` is the honest name for a topic the engine has accepted but not started: it is
 * behind the five-topic semaphore, not stalled and not lost. Naming it is what stops an
 * operator reading a run of twelve topics with four bars moving as eight broken ones.
 */
export function summarize(topics: TopicRun[]) {
  return {
    shipped: topics.filter((t) => t.status === "done").length,
    review: topics.filter((t) => t.status === "needs_review").length,
    failed: topics.filter((t) => t.status === "failed").length,
    /**
     * Counted apart from `failed`, never folded into it. These counts are what the session card
     * sums, and its promise is that they add up to the total: a stopped topic with nowhere to be
     * counted would silently vanish from a run of five that reported four. Folding it into
     * `failed` would keep the sum and break the meaning, which is worse: it would report the
     * operator's own Stop back to them as blogs the engine could not write.
     */
    stopped: topics.filter((t) => t.status === "stopped").length,
    running: topics.filter((t) => t.started && t.status === "running").length,
    queued: topics.filter((t) => !t.started).length,
  };
}

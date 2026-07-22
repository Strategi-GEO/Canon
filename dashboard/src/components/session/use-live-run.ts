"use client";

import * as React from "react";
import { ApiError } from "@/lib/api";
import {
  seedsFor,
  useRunStream,
  type Seed,
  type StreamState,
} from "@/components/create/use-run-stream";
import { useRuns } from "@/lib/runs-context";
import { runStateOf, type Session } from "@/lib/sessions";
import type { RoadmapState } from "@/lib/use-roadmap";
import type { RunState } from "@/types";

const NO_SEEDS: Seed[] = [];
const NO_SESSIONS: Session[] = [];

export type LiveRun = {
  runId: string;
  /**
   * Where this session sits against the engine's CLIENT_LOCK. "finished" and "stopped" are both
   * reachable here even though neither is a live session, because this outlives the session on
   * purpose: the card's closing summary is its payoff and must not vanish the instant the run
   * ends. That matters most on a stop, where the summary is the reassurance that the finished
   * blogs were kept, and it would be the one thing the operator never got to read.
   */
  state: RunState;
  /**
   * SUBMIT time. Feeds the WAITING clock and nothing else. A queued session's `started` can be
   * ten minutes old with nothing having run, so measuring work from it is the one lie this
   * split exists to prevent.
   */
  submittedAt: string;
  /** When the engine actually began work. Null while queued. Feeds the RUNNING clock. */
  runningSince: string | null;
  /** Which half of a running run this is: "facts" or "topics". Null while queued or from an
   *  engine that predates the field. Picks the heading and which clock the card shows. */
  phase: "facts" | "topics" | null;
  /** When the current phase began. The fresh blog clock measures from it. */
  phaseStarted: string | null;
  /** From the engine's own run record, so it is known before a single frame exists. */
  topicCount: number;
  /**
   * The sessions the engine will work BEFORE this one, in queue order. Empty unless this
   * session is queued, which is the only state in which anything is ahead of it at all.
   */
  ahead: Session[];
  /**
   * This brand's OTHER live sessions, the ones this card is not showing. Almost always empty:
   * it fills when an operator submits a second batch for a brand that is already running, which
   * is the exact moment they come to the Overview to check the thing they just did.
   */
  others: Session[];
};

export type LiveRunState = {
  /** This brand's session. Null both while the answer is unknown and when there is none. */
  run: LiveRun | null;
  /**
   * The topic feed. EMPTY of real frames while `run.state` is "queued", because a session that
   * has not taken CLIENT_LOCK cannot have produced one. Read it only once work has started.
   */
  stream: StreamState;
  /** The engine's own refusal, or its unreachability. Never flattened into a null run. */
  error: ApiError | null;
  /** True until the answer is in. `run` null with `checking` false is the real "no run". */
  checking: boolean;
};

/**
 * This brand's session, off the one engine-wide run list, plus its place in the queue.
 *
 * The list is polled ABOVE this hook (lib/runs-context) rather than fetched here. It used to
 * fetch once on mount, which was enough while the only question was "is this brand running",
 * and is not enough now: a session sits queued behind ANOTHER brand's, and the moment it takes
 * CLIENT_LOCK is reported by no SSE frame this card subscribes to. A one shot read would leave
 * a session that started ten minutes ago still reading "queued" until the operator refreshed.
 * One poll feeds this card and the topbar both, so they can never disagree about the queue.
 *
 * The roadmap arrives as state rather than as rows because this hook has to know the
 * difference between "no rows" and "rows not loaded yet", and it must NOT fetch the CSV a
 * second time: the Overview already reads it once and hands the same object to every card.
 */
export function useLiveRun(brandSlug: string, roadmap: RoadmapState): LiveRunState {
  const { runs, queue, error, checking } = useRuns();

  /**
   * The run this card attached to. Held rather than re-derived every poll, because a session
   * that ENDS leaves the live set while the card still owes the operator its closing summary,
   * the one carrying "3 shipped" and the way to the blogs. Deriving from the live set alone
   * would delete that card at the exact moment it became worth reading.
   */
  const [attached, setAttached] = React.useState<{ slug: string; runId: string } | null>(null);

  /**
   * This brand's session, off the QUEUE rather than the raw run list, so the choice is stated
   * rather than inherited.
   *
   * A brand can genuinely have several live sessions at once: one running and one the operator
   * submitted behind it. `queue` is sorted running first, then by submit time, so this takes
   * the running one deliberately. Reading the raw list happened to land on the same run only
   * because RUNS is insertion ordered and the lock is FIFO, and were that ever to invert, the
   * card would render "Session queued, nothing has started" over a brand whose blogs were
   * running: the exact inverse of the lie this card exists to prevent.
   */
  const live = queue.find((session) => session.clientSlug === brandSlug) ?? null;

  // Adjusting state during render is React's own answer to a prop change that invalidates
  // state, and it settles in one pass: the id only ever changes when the engine reports a
  // genuinely different run for this brand, so this is not a per poll write. A newly submitted
  // session replaces a finished one, which is correct, and is what the operator just did.
  if (live !== null && (attached?.slug !== brandSlug || attached.runId !== live.runId)) {
    setAttached({ slug: brandSlug, runId: live.runId });
  }

  // Compared against the slug being asked about rather than reset from an effect. Were the
  // brand to change without this hook's owner remounting, `attached` still describes the
  // PREVIOUS brand, and showing one brand's session under another brand's name is the worst
  // answer available.
  const runId = attached?.slug === brandSlug ? attached.runId : null;

  // The engine keeps a finished run queryable, so this keeps resolving after the session ends
  // and the card keeps its summary. It goes null only if the engine forgets the run outright,
  // which is a restart, and a card that quietly disappears is the honest answer to that.
  const record = React.useMemo(
    () => (runId === null ? null : (runs.find((run) => run.run_id === runId) ?? null)),
    [runs, runId],
  );

  const state = record === null ? null : runStateOf(record);

  const rows = roadmap.data?.rows;
  const seeds = React.useMemo(
    () => (record === null ? NO_SEEDS : seedsFor(record.topics, rows ?? [])),
    [record, rows],
  );

  /**
   * No subscription while the session is QUEUED. It has not taken CLIENT_LOCK, so no agent has
   * run and no frame exists to receive: the feed would sit silent for as long as another brand
   * held the lock, and every topic would render as accepted-but-idle, which is indistinguishable
   * from a wedged run. The card says "queued" from the run record instead, and this attaches the
   * moment the engine reports work has begun.
   *
   * Held back until the roadmap settles for the separate reason that useRunStream binds seeds
   * when a run id first arrives and ignores them after. Attaching while the CSV is in flight
   * would freeze every topic's name as its slug for the life of the run, and the labels an
   * operator recognises are their own H1s, which live in the roadmap rows.
   */
  const streamId =
    record !== null && state !== "queued" && !roadmap.loading ? record.run_id : null;
  const stream = useRunStream(streamId, seeds);

  const ahead = React.useMemo(() => {
    if (runId === null) {
      return NO_SESSIONS;
    }
    const at = queue.findIndex((session) => session.runId === runId);
    return at <= 0 ? NO_SESSIONS : queue.slice(0, at);
  }, [queue, runId]);

  /**
   * The brand's other live sessions. The card shows ONE session, and a brand with a second one
   * waiting would otherwise have it appear nowhere on its own Overview: the operator submits a
   * batch behind a running one, comes here to check it, and sees only the batch they did not
   * just start. The card cannot render both without holding a stream per session, so it names
   * the rest instead, which is what the queue in the header is for.
   */
  const others = React.useMemo(() => {
    if (runId === null) {
      return NO_SESSIONS;
    }
    const rest = queue.filter(
      (session) => session.clientSlug === brandSlug && session.runId !== runId,
    );
    return rest.length === 0 ? NO_SESSIONS : rest;
  }, [queue, runId, brandSlug]);

  return {
    run:
      record === null || state === null
        ? null
        : {
            runId: record.run_id,
            state,
            submittedAt: record.started,
            runningSince: record.started_running,
            phase: record.phase ?? null,
            phaseStarted: record.phase_started ?? null,
            topicCount: record.topics.length,
            ahead,
            others,
          },
    stream,
    // A dropped poll is only this card's business when it has nothing better to say. A session
    // already on screen was not made untrue by a request that failed afterwards, and replacing
    // a live run with an error line would cost the operator the very thing they are watching.
    error: record === null ? error : null,
    checking: checking || roadmap.loading,
  };
}

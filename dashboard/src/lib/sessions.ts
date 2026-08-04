/**
 * What the engine's run list MEANS: which sessions are live, in what order the engine will
 * work them, and which clock each one has earned.
 *
 * Pure, and separate from the provider that fetches the list, because these are the rules the
 * queue view is right or wrong about. Ordering IS the queue, and picking the wrong instant to
 * measure from is how a session that has not started claims eight minutes of work. Rules that
 * load bearing should be runnable against a captured payload without mounting React.
 */

import type { RunState, RunSummary } from "@/types";

/**
 * The engine's TOPIC_SEMAPHORE, from runner.py: BLOGS in flight across the whole engine, from
 * every door there is. A Create-tab batch, a retry, an answer-driven revise and a repurpose all
 * take one slot each out of this number, so it is the size of one shared queue and not a
 * per-session allowance.
 *
 * It lives here rather than in either view that prints it, because it describes the ENGINE and
 * not the Create tab. It was declared twice, once in watch-state and once in select-state, so
 * a change to runner.py had two places to land and no reason to find the second. Everything
 * that names this number now imports it from the same file that decides what the run list
 * means.
 */
export const ENGINE_SLOTS = 5;

/** A live session, normalised. Nothing finished ever becomes one. */
export type Session = {
  runId: string;
  /** The BRAND slug the engine keys the run by. A key, not a label: resolve it before render. */
  clientSlug: string;
  /** Live sessions only, so neither "finished" nor "stopped" is representable here. */
  state: "queued" | "running";
  /** Submit time. The only clock a QUEUED session has, and it measures waiting, not work. */
  submittedAt: string;
  /** When work began. Null while queued, and the type keeps it that way on purpose. */
  runningSince: string | null;
  /** Which half of a running session this is. Null while queued, or from an older engine. */
  phase: "facts" | "topics" | null;
  /** When the current phase began. Feeds the fresh blog-generation clock. */
  phaseStarted: string | null;
  topicCount: number;
};

/**
 * What state a run is really in.
 *
 * `state` is the authority when the engine sends it. The fallback exists because this field is
 * new and the type layer already described this endpoint wrongly once: were it absent, reading
 * a missing value as "running" would put a "running for 8 minutes" clock on a session that has
 * not started, which is precisely the lie this whole feature exists to kill. `started_running`
 * is null exactly while queued, so it answers the same question independently, and it fails
 * towards "queued" rather than towards a fabricated elapsed.
 */
export function runStateOf(run: RunSummary): RunState {
  if (
    run.state === "queued" ||
    run.state === "running" ||
    run.state === "finished" ||
    run.state === "stopped"
  ) {
    return run.state;
  }
  if (!run.live) {
    return "finished";
  }
  return run.started_running === null ? "queued" : "running";
}

/**
 * A run the engine will do no more work on, whichever way it ended.
 *
 * The two terminal states are one question for anything that has to decide whether to keep a
 * clock ticking, hold a queue slot, or lock a roadmap row, and a different question for anything
 * that has to put a word on screen. This answers the first and only the first. It is a type
 * predicate so that every caller which stores a LIVE state gets a compile error rather than a
 * stopped run quietly filed among the running ones.
 *
 * "finished" alone was the whole of this test before Stop existed, and every reader of it would
 * have kept a stopped session in the queue with a clock running: the exact reading the run list
 * exists to prevent.
 */
export function hasEnded(state: RunState): state is "finished" | "stopped" {
  return state === "finished" || state === "stopped";
}

export function isLive(run: RunSummary): boolean {
  return !hasEnded(runStateOf(run));
}

/** One live session, or null for a run that has ended, however it ended. */
export function sessionOf(run: RunSummary): Session | null {
  const state = runStateOf(run);
  // A STOPPED run leaves the queue exactly as a finished one does. Nothing waits behind it, it
  // holds no lock, and it will never take one: leaving it in would have the header count it
  // among the sessions ahead of the next brand, and that brand's operator would be told to wait
  // on a session the engine has already let go of.
  if (hasEnded(state)) {
    return null;
  }
  return {
    runId: run.run_id,
    clientSlug: run.client,
    state,
    submittedAt: run.started,
    runningSince: run.started_running,
    phase: run.phase ?? null,
    phaseStarted: run.phase_started ?? null,
    topicCount: run.topics.length,
  };
}

/**
 * The live sessions in the order the engine will actually work them: whatever is already
 * holding slots first, then everyone else by submit time.
 *
 * The order is not decoration. This list is a QUEUE, so an operator reads position as "how
 * many sessions before mine", and sorting it any other way would state something false about
 * what happens next. Submit time is the tiebreak because asyncio.Semaphore wakes waiters in
 * arrival order, so `started` ascending is the engine's own ordering and not a guess.
 *
 * A RUNNING SESSION AHEAD DOES NOT BLOCK THIS ONE OUTRIGHT, and no caller should imply it does.
 * The engine works ENGINE_SLOTS blogs at once regardless of which sessions they belong to, so a
 * session ahead that is down to its last blog is holding one slot and leaving the rest free.
 *
 * Compared as instants rather than as strings. The engine sends uniformly offset ISO, so a
 * collator happens to order these correctly today, but the question being asked is "which was
 * submitted first" and Date.parse is the only thing that answers it for any two instants the
 * engine could send.
 */
export function queueOf(runs: readonly RunSummary[]): Session[] {
  return runs
    .map(sessionOf)
    .filter((session): session is Session => session !== null)
    .sort((a, b) => {
      if (a.state !== b.state) {
        return a.state === "running" ? -1 : 1;
      }
      return Date.parse(a.submittedAt) - Date.parse(b.submittedAt);
    });
}

/** The one clock a session is entitled to, with the word that says what it measures. */
export type SessionClock = {
  /** The ISO instant to measure from. Never null, so formatElapsed can never be fed one. */
  since: string;
  /** "running" measures blog work. "waiting" measures time queued behind other blogs.
   *  "building" measures the canonical-facts build, which is deliberately NOT blog work. */
  measures: "running" | "waiting" | "building";
};

/**
 * A queued session has waited since it was submitted; a running one has run since it took the
 * lock. Two different questions, and this is the only place either is answered, so no caller
 * can reach for `started` on a running session and report ten minutes of queueing as work.
 *
 * THE PHASE SPLITS THE RUNNING CLOCK IN TWO, live runs only. While the engine reports "facts",
 * the clock measures the BUILD and says so; the moment blogs dispatch it measures from the
 * flip (`phaseStarted`), a FRESH timer, because the facts build's minutes are not blog work
 * and a single clock was billing them to the blogs. Phase fields are optional so every caller
 * that predates them, and every payload from an engine that does, falls back to the old single
 * clock from `runningSince`. A FINISHED or STOPPED session ignores the phase on purpose: what
 * it is owed is how long the whole run took.
 *
 * Returns null rather than a zero when a running session somehow carries no start: the engine
 * sets `started_running` as it takes the lock, so this should be unreachable, and inventing
 * "0s" for it would put a confidently wrong number on screen. No clock says less and lies not
 * at all. That null is also why callers cannot hand formatElapsed a missing timestamp and
 * render "NaN": there is nothing to hand it.
 */
export function clockOf(session: {
  state: RunState;
  submittedAt: string;
  runningSince: string | null;
  phase?: "facts" | "topics" | null;
  phaseStarted?: string | null;
}): SessionClock | null {
  if (session.state === "queued") {
    return { since: session.submittedAt, measures: "waiting" };
  }
  if (session.runningSince === null) {
    // A session STOPPED while still queued never ran: no clock at all rather than a duration
    // measured from a submit it never acted on.
    return null;
  }
  if (session.state === "running") {
    if (session.phase === "facts") {
      return { since: session.phaseStarted ?? session.runningSince, measures: "building" };
    }
    if (session.phase === "topics" && session.phaseStarted != null) {
      return { since: session.phaseStarted, measures: "running" };
    }
  }
  // A FINISHED session lands here, and correctly: what it is owed is how long it ran,
  // measured from the lock. Its caller freezes the clock, so the reading stops at the end
  // rather than ticking on forever.
  return { since: session.runningSince, measures: "running" };
}

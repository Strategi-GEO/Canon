/**
 * What a finished Claude Code query MEANS to the bell: which of them are news, and what each one
 * says.
 *
 * Pure, and separate from the provider that watches for them, for the same reason lib/sessions
 * is separate from lib/runs-context: these are the rules the badge is right or wrong about, and
 * getting them wrong is how a bell cries wolf on every page load or stays silent through the one
 * event the operator was waiting for. Rules this load bearing should be runnable against a
 * captured payload without mounting React.
 *
 * ONE RULE, NO EXCEPTIONS: every notification counts. There is deliberately no "you were already
 * looking at that page" suppression here. It was built and then taken out, because a count whose
 * meaning depends on where you were standing when it arrived is a count you have to reason about,
 * and the bell's whole job is to be glanceable. Every finished query is +1 until the operator
 * opens the bell. That is the entire contract, and it fits in one sentence on purpose.
 */

import { runStateOf } from "@/lib/sessions";
import type { RunState, RunSummary } from "@/types";

/**
 * The kinds of work this engine runs on the operator's behalf, each one a Claude Code session
 * that takes long enough to walk away from, plus the portal events that arrive with no session
 * at all: "answers", "changes_requested" and "client_approved" are a CLIENT acting in their
 * portal, which has no channel into this app, so the first a producer can know is its own next
 * read of the record. They ring the same bell because the operator's question is the same
 * either way: what happened while I was not looking, and what does it need from me.
 *
 * "roadmap" is declared and nothing emits it yet, which is deliberate rather than an oversight.
 * server/prompts/roadmap-generation.md is written and server/roadmap_gen.py, the driver its own
 * header names, does not exist, so the Generate roadmap button on the Content Roadmap tab is
 * disabled and says so. Naming the kind here is what makes wiring it later a single notify()
 * call at the point the job settles, rather than a second pass over this whole file. Until that
 * driver lands, no code path constructs one and the operator never sees the word.
 */
export type NotificationKind =
  | "run"
  | "describe"
  | "roadmap"
  | "answers"
  | "changes_requested"
  | "client_approved";

export type AppNotification = {
  /** `${kind}:${key}`, so the same settled job observed by two polls can never list twice. */
  id: string;
  kind: NotificationKind;
  /** The engine's key for the brand. A key, never a label: resolve it through findBrand. */
  brandSlug: string;
  /**
   * When THIS TAB saw it, never when the engine did. The poll runs up to four seconds behind,
   * and the run record's own instants describe the run rather than the moment it ended, so
   * neither answers "how long ago was I told".
   */
  observedAt: string;
  /** Null when findBrand cannot resolve the slug. No link beats a guessed URL. */
  href: string | null;
  /** False from birth, always. Only opening the bell clears it. Never flipped back. */
  read: boolean;
  /**
   * What the kind counts: blogs for a run, answered questions for "answers", open
   * suggestions for "changes_requested". Null for kinds that count nothing.
   */
  topicCount: number | null;
  /** The engine's own words when the work failed, or null. Never flattened to "". */
  error: string | null;
};

/**
 * The runs that finished BETWEEN two readings of the engine's run list.
 *
 * A transition, never a state, and that distinction is the entire defence against a bell that
 * screams on load. runner.RUNS is a module dict the engine never prunes, so GET /api/runs
 * returns every run since uvicorn started, all of them finished; "notify on any finished run"
 * would fire a dozen toasts on first paint and again on every refresh.
 *
 * So a run must have been WATCHED live to be news. `observed` holds what this tab last saw, and
 * a run_id it does not know is skipped no matter what state it arrives in: that run started and
 * ended entirely outside this tab's sight, which makes it history. This bell reports what
 * happened while the operator was here, and it is not a log of everything that ever ran.
 */
export function runFinishEdges(
  observed: ReadonlyMap<string, RunState>,
  next: readonly RunSummary[],
): RunSummary[] {
  return next.filter((run) => {
    const before = observed.get(run.run_id);
    if (before === undefined || before === "finished") {
      return false;
    }
    return runStateOf(run) === "finished";
  });
}

/** What this tab has watched, for the next poll to diff against. */
export function observeRuns(runs: readonly RunSummary[]): Map<string, RunState> {
  return new Map(runs.map((run) => [run.run_id, runStateOf(run)]));
}

/**
 * One blog's standing in the client review loop, as this tab last read it.
 *
 * Everything the portal can do to a blog with no channel into this app: answer the
 * evaluator's questions, suggest changes on a sent article, approve it. The bell hears about
 * all three at the read that discovers them, so this is what a read has to remember.
 */
export type ReviewSighting = {
  topicSlug: string;
  /** The iteration of the CLIENT-answered form on disk, or null when there is none. It moves
   *  when a later iteration's form is answered, which is a genuinely new answering round. */
  answeredIter: number | null;
  /** How many questions that form holds, for the sentence the bell renders. */
  answeredCount: number;
  /** The client's suggestions still owed a resolution. A ROUND is a rise from zero here, and
   *  never the number itself. */
  changes: number;
  /** The approval stamp. Every send clears it, so a fresh approval is a fresh string. */
  approved: string | null;
};

export type ReviewEdge = {
  kind: "answers" | "changes_requested" | "client_approved";
  topicSlug: string;
  /** The part of the bell id that makes this event unique within its kind. */
  stamp: string;
  topicCount: number | null;
};

/**
 * What the CLIENT did between two readings of a brand's blogs.
 *
 * A TRANSITION, NEVER A STATE, for exactly the reason runFinishEdges above is one, and both
 * of this producer's dedup bugs were the same missing idea. The bell log is this tab's own
 * memory and nothing is persisted, so an approval stamped last Tuesday is still sitting on
 * the summary today: announcing on the STATE re-rang every approval and every open round of
 * suggestions the brand had ever accumulated, on every fresh tab, which is how a bell becomes
 * something an operator learns to dismiss without reading. A topic this observer has never
 * seen is therefore skipped whatever it carries, which is the same rule the runs edge applies
 * to a run that started and ended outside this tab's sight.
 *
 * THE ROUND OF SUGGESTIONS IS A RISE FROM ZERO, not the send stamp it arrives under. Keying
 * it on the send meant a client whose first two suggestions were resolved, and who then read
 * the article again and asked for one more thing, rang nothing at all: same send, same key,
 * already announced. The operator's only clue was a number on a table they had no reason to
 * re-read. A rise from zero rings once per round however many comments the round holds, which
 * is what keying on the send was reaching for, and it rings again for the next round.
 *
 * `now` is the stamp for that kind, and it is the honest one: a round has no identity of its
 * own on the summaries wire, the send stamp covers every round inside one send, and the count
 * repeats. The RISE is the news; the id only has to be unique, and two rises cannot share an
 * instant. It is passed in rather than read here so this stays pure and runnable against a
 * captured pair of payloads.
 */
export function reviewEdges(
  observed: ReadonlyMap<string, ReviewSighting>,
  next: readonly ReviewSighting[],
  now: string,
): ReviewEdge[] {
  const edges: ReviewEdge[] = [];
  for (const sighting of next) {
    const before = observed.get(sighting.topicSlug);
    if (before === undefined) {
      continue;
    }
    if (sighting.answeredIter !== null && sighting.answeredIter !== before.answeredIter) {
      edges.push({
        kind: "answers",
        topicSlug: sighting.topicSlug,
        stamp: String(sighting.answeredIter),
        topicCount: sighting.answeredCount,
      });
    }
    if (sighting.changes > 0 && before.changes === 0) {
      edges.push({
        kind: "changes_requested",
        topicSlug: sighting.topicSlug,
        stamp: now,
        topicCount: sighting.changes,
      });
    }
    if (sighting.approved !== null && sighting.approved !== before.approved) {
      edges.push({
        kind: "client_approved",
        topicSlug: sighting.topicSlug,
        stamp: sighting.approved,
        topicCount: null,
      });
    }
  }
  return edges;
}

/** What this tab has read of one brand's review loop, for the next read to diff against. */
export function observeReview(next: readonly ReviewSighting[]): Map<string, ReviewSighting> {
  return new Map(next.map((sighting) => [sighting.topicSlug, sighting]));
}

/**
 * The review baseline OUTLIVES THE TAB, and it is the only thing in this file that does.
 *
 * Nothing about the client's half of this loop is watched for any more: the poll that used to
 * discover a suggestion within ten seconds is gone, because live cross-person updates are not
 * worth a timer in every open tab when the events are hours apart. A REFRESH is the update
 * mechanism now, which puts the whole weight of "the other person hears about it" on the bell.
 *
 * An in-memory baseline cannot carry that weight. It starts empty on every page load, and
 * reviewEdges deliberately skips a topic it has never seen, so a client who comments while the
 * operator's tab is closed announces nothing on the next load: the diff has nothing to diff
 * against. That is not a stale-ring bug, it is a silent-miss bug, and it is worse. Persisting
 * the baseline is what makes the FIRST read after an event the read that reports it.
 *
 * Storing the baseline rather than the announcements is also what keeps the old rule intact:
 * the log stays this tab's record of what it watched happen, and an approval stamped last
 * Tuesday still rings nothing, because it is already in the stored baseline.
 *
 * Storage is best effort by construction. Private browsing, a full quota and a hand-edited
 * value all fold to "no baseline", which costs one missed announcement and never an error: the
 * delivery chips on the blog rows carry the same news permanently, so the bell is the fast
 * path and not the only one.
 */
const REVIEW_SEEN_KEY = "geo-factory.review-seen";

export function loadObservedReview(brandSlug: string): Map<string, ReviewSighting> {
  if (typeof window === "undefined") {
    return new Map();
  }
  try {
    const raw = window.localStorage.getItem(`${REVIEW_SEEN_KEY}.${brandSlug}`);
    if (raw === null) {
      return new Map();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Map();
    }
    const seen = new Map<string, ReviewSighting>();
    for (const entry of parsed) {
      // Field by field, because this string survived a deploy and may predate any shape this
      // code knows. A malformed entry is dropped rather than trusted into a diff.
      const row = entry as Partial<ReviewSighting>;
      if (typeof row?.topicSlug !== "string" || row.topicSlug === "") {
        continue;
      }
      seen.set(row.topicSlug, {
        topicSlug: row.topicSlug,
        answeredIter: typeof row.answeredIter === "number" ? row.answeredIter : null,
        answeredCount: typeof row.answeredCount === "number" ? row.answeredCount : 0,
        changes: typeof row.changes === "number" ? row.changes : 0,
        approved: typeof row.approved === "string" ? row.approved : null,
      });
    }
    return seen;
  } catch {
    return new Map();
  }
}

export function saveObservedReview(
  brandSlug: string,
  seen: ReadonlyMap<string, ReviewSighting>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      `${REVIEW_SEEN_KEY}.${brandSlug}`,
      JSON.stringify([...seen.values()]),
    );
  } catch {
    // A refused write means the next load re-announces at most one round. Nothing to report.
  }
}

export function unreadOf(log: readonly AppNotification[]): number {
  return log.reduce((count, note) => (note.read ? count : count + 1), 0);
}

/** What one finished job SAYS, in the operator's words rather than the engine's. */
export type NotificationCopy = {
  title: string;
  /** One line. The bell row and the toast render this same string, never two versions of it. */
  body: string;
};

/**
 * The words for one notification, derived in ONE place so the toast that fires now and the bell
 * row that renders it later can never drift into saying two different things about one event.
 *
 * The brand NAME is passed in rather than read here: the notification carries the engine's slug,
 * which is a key, and resolving a key to a label is the caller's job in every other view here.
 *
 * A run under-claims on purpose. RunSummary.topics carries the topic slugs and nothing else, no
 * score and no per-topic status, so this can honestly say how many blogs the run held and not
 * how many shipped. The link goes to the Blogs tab, which owns those numbers and reads them off
 * disk. Guessing them here to make a richer sentence is the one thing this bell must never do.
 */
export function copyFor(note: AppNotification, brandName: string): NotificationCopy {
  if (note.kind === "run") {
    const count = note.topicCount ?? 0;
    return {
      title: "Blog run finished",
      body: `${brandName}: ${count} ${count === 1 ? "blog" : "blogs"}. Open Blogs for the scores.`,
    };
  }

  if (note.kind === "describe") {
    return note.error === null
      ? {
          title: "Description drafted",
          body: `${brandName}: Claude Code read the site and returned a draft. Nothing is saved until you submit it.`,
        }
      : {
          title: "Description draft failed",
          body: `${brandName}: ${note.error}`,
        };
  }

  if (note.kind === "answers") {
    // The portal loop closing: a client answered where no engine exists, so the revise those
    // answers are owed waits on the operator's Rerun, and this is the bell saying so.
    const count = note.topicCount ?? 0;
    return {
      title: "Client answered review questions",
      body: `${brandName}: ${count} ${count === 1 ? "question" : "questions"} answered from the portal. Open Blogs and click Rerun to apply them.`,
    };
  }

  if (note.kind === "changes_requested") {
    // The other portal loop: a client read the sent article and suggested changes. Each one
    // waits on the operator's Resolve with Claude, and the blog cannot be re-sent past them.
    const count = note.topicCount ?? 0;
    return {
      title: "Client requested changes",
      body: `${brandName}: ${count} ${count === 1 ? "suggestion" : "suggestions"} from the portal. Open the blog to resolve each with Claude or dismiss it.`,
    };
  }

  if (note.kind === "client_approved") {
    // Nothing is owed here: the approval is the client's own act, and this line is the team
    // hearing it. The blog page shows the stamp; publishing remains the operator's move.
    return {
      title: "Client approved a blog",
      body: `${brandName}: the client approved a sent article from their portal. It is ready to take live.`,
    };
  }

  return note.error === null
    ? { title: "Roadmap generated", body: `${brandName}: the roadmap is ready.` }
    : { title: "Roadmap generation failed", body: `${brandName}: ${note.error}` };
}

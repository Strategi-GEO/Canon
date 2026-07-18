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
 * that takes long enough to walk away from.
 *
 * "roadmap" is declared and nothing emits it yet, which is deliberate rather than an oversight.
 * server/prompts/roadmap-generation.md is written and server/roadmap_gen.py, the driver its own
 * header names, does not exist, so the Generate roadmap button on the Content Roadmap tab is
 * disabled and says so. Naming the kind here is what makes wiring it later a single notify()
 * call at the point the job settles, rather than a second pass over this whole file. Until that
 * driver lands, no code path constructs one and the operator never sees the word.
 */
export type NotificationKind = "run" | "describe" | "roadmap" | "answers";

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
  /** For a run, how many blogs it carried. Null for kinds that do not count anything. */
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

  return note.error === null
    ? { title: "Roadmap generated", body: `${brandName}: the roadmap is ready.` }
    : { title: "Roadmap generation failed", body: `${brandName}: ${note.error}` };
}

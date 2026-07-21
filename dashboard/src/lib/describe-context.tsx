"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import { useNotifications } from "@/lib/notifications-context";
import { useOrgs } from "@/lib/orgs-context";
import type { DescribeJob } from "@/types";

/**
 * Every brand description draft the engine is running, watched from above the route that started
 * it.
 *
 * WHY THIS IS A PROVIDER. server/describe.py owns the work: adding a brand starts an SDK session
 * and the POST returns immediately, and the session reads the site and SAVES the description tens
 * of seconds later whatever the browser does. The add form that started it has long since
 * navigated to the brand, so the wait cannot live there. It lives here, above every route, so a
 * settled draft is noticed wherever the operator has gone: this provider announces it and re-reads
 * the hierarchy so the generated description appears on the brand's page (see `apply`).
 *
 * WHY IT DISCOVERS RATHER THAN REMEMBERS. It reads GET /api/describe-jobs, the whole list, the
 * same way lib/runs-context reads the run list. The browser keeps no registry of what it
 * started, so a reload mid draft reattaches to the running job instead of losing it, which is
 * the exact property server/describe.py was rewritten to provide and which nothing was using.
 */

type DescribeState = {
  /** The engine's draft jobs, by brand slug. Live and settled alike, exactly as sent. */
  jobs: ReadonlyMap<string, DescribeJob>;
  /** Starts a draft for one brand. Resolves once the engine has accepted it, not when it lands. */
  start: (slug: string) => Promise<void>;
  /** Drops a settled job once its draft has been taken or dismissed. */
  clear: (slug: string) => void;
  /** The engine's reason a start was refused, per brand, or null. 409 while a run is live. */
  startError: ReadonlyMap<string, ApiError>;
};

const DescribeContext = React.createContext<DescribeState | null>(null);

/**
 * Two and a half seconds, and only while a draft is actually running.
 *
 * A draft is one scrape and one paragraph, so it settles in tens of seconds and a slower poll
 * would leave the operator watching a spinner well past the answer. There is NO idle poll: this
 * is a rare onboarding action, and a permanent heartbeat against the same asyncio loop that runs
 * blog generation, on every idle tab, forever, to catch an event that happens twice a week, is
 * the trade lib/runs-context already documents as not worth making.
 */
const POLL_MS = 2500;

const NO_JOBS: ReadonlyMap<string, DescribeJob> = new Map();
const NO_ERRORS: ReadonlyMap<string, ApiError> = new Map();

function settled(job: DescribeJob): boolean {
  return job.state !== "running";
}

export function DescribeProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = React.useState<ReadonlyMap<string, DescribeJob>>(NO_JOBS);
  const [startError, setStartError] = React.useState<ReadonlyMap<string, ApiError>>(NO_ERRORS);
  const { notify } = useNotifications();
  // The engine now SAVES the description before it flips a draft to "done" (server/describe.py),
  // so a settled draft means the record already changed underneath the list this browser is
  // showing. Re-reading the hierarchy is what makes the freshly generated description appear on
  // the brand's page without a manual reload. OrgsProvider is above DescribeProvider, so this is
  // in scope.
  const { refresh } = useOrgs();

  /**
   * What this tab has already seen settle, so one finished draft is announced once.
   *
   * A ref, not state: it records what was WATCHED and must never schedule a render of its own.
   * The engine holds a settled job until someone DELETEs it, so every poll re-reports it, and
   * without this the same draft would toast every 2.5 seconds until collected.
   *
   * Null until the first read lands, which is what makes a cold start silent: a job that was
   * already settled the first time this tab looked finished before the operator got here, and
   * announcing it would mean a reload firing notifications for old news.
   */
  const announced = React.useRef<Set<string> | null>(null);
  // Read from a settling poll, long after the render that armed it, and written in an effect
  // rather than during render because a ref is not render data.
  const notifyRef = React.useRef(notify);
  const refreshRef = React.useRef(refresh);
  React.useEffect(() => {
    notifyRef.current = notify;
    refreshRef.current = refresh;
  });

  const apply = React.useCallback((list: DescribeJob[]) => {
    setJobs(new Map(list.map((job) => [job.client, job])));

    const seen = announced.current;
    if (seen === null) {
      // Baseline. Every job already settled at first sight is history, not news.
      announced.current = new Set(list.filter(settled).map((job) => job.client));
      return;
    }

    let settledNow = false;
    for (const job of list) {
      if (!settled(job) || seen.has(job.client)) {
        continue;
      }
      seen.add(job.client);
      settledNow = true;
      notifyRef.current({
        kind: "describe",
        brandSlug: job.client,
        // The brand slug, because the engine allows exactly one draft per brand at a time. Two
        // drafts for one brand cannot coexist, so nothing finer can collide.
        key: job.client,
        error: job.error,
      });
    }

    // A draft settled this poll, so the record it wrote its description into has changed. Re-read
    // the hierarchy once so the brand's page shows the generated description instead of the empty
    // state it landed on seconds earlier. Gated on `settledNow` and the `seen` newness check
    // above, so a job that lingers settled across later polls never re-fires this.
    if (settledNow) {
      void refreshRef.current();
    }

    // A job the engine no longer holds was collected, so the next draft for that brand is news
    // again. Without this, drafting twice for one brand would announce only the first.
    const present = new Set(list.map((job) => job.client));
    for (const slug of [...seen]) {
      if (!present.has(slug)) {
        seen.delete(slug);
      }
    }
  }, []);

  const running = React.useMemo(() => [...jobs.values()].some((job) => !settled(job)), [jobs]);

  /**
   * Reads the list once on mount to reattach to anything already in flight, then keeps reading
   * only while something is running. `running` in the dependency list is what arms and disarms
   * it: a draft starting flips it true and the poll begins, and the draft settling flips it back
   * and the poll stops.
   */
  React.useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    // The one way two reads overlap: a poll in flight while the tab hides, settling after the
    // operator returns and the visibility handler has already started another.
    let inFlight = false;

    function schedule() {
      window.clearTimeout(timer);
      // A hidden tab is nobody watching, and this poll exists to keep a spinner and a bell
      // honest on a screen. The list is server state read whole every time, never a stream of
      // deltas, so the first read on return is complete and nothing is lost by stopping.
      if (!running || document.visibilityState === "hidden") {
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    }

    function poll() {
      if (inFlight) {
        return;
      }
      inFlight = true;
      api.describeJobs(controller.signal).then(
        ({ jobs: next }) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          apply(next);
          schedule();
        },
        (cause: unknown) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          /*
            The jobs already on screen are NOT cleared, and the baseline is NOT touched. An engine
            that stopped answering has not told us any draft ended, so blanking this would report
            a running draft as gone on one dropped request, and resetting `announced` would
            re-announce every settled draft the moment it came back. The button keeps its spinner
            and the poll keeps trying.
          */
          schedule();
        },
      );
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        poll();
      }
    }

    poll();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [apply, running]);

  const start = React.useCallback(
    async (slug: string) => {
      setStartError((current) => {
        if (!current.has(slug)) {
          return current;
        }
        const next = new Map(current);
        next.delete(slug);
        return next;
      });
      try {
        const job = await api.startDescribe(slug);
        // Adopt the 202 immediately rather than waiting up to a poll for the spinner to appear.
        // The engine sends the job record itself, so this is the same shape the poll would bring
        // and it cannot disagree with it.
        setJobs((current) => new Map(current).set(job.client, job));
      } catch (cause) {
        // The engine refuses with real reasons: 409 while a run for this brand is live, because
        // one draft session would compete with five topics for the same quota. That reason is
        // the whole point of the error and it reaches the operator verbatim.
        setStartError((current) =>
          new Map(current).set(
            slug,
            cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
          ),
        );
      }
    },
    [],
  );

  const clear = React.useCallback((slug: string) => {
    setJobs((current) => {
      const next = new Map(current);
      next.delete(slug);
      return next;
    });
    // Fire and forget: the description is already saved to the record by the time a draft
    // settles, so a failed DELETE costs nothing worse than the engine holding a spent record
    // again. Blocking the collect on it would be the tail wagging the dog.
    void api.clearDescribeJob(slug).catch(() => {});
  }, []);

  const value = React.useMemo<DescribeState>(
    () => ({ jobs, start, clear, startError }),
    [jobs, start, clear, startError],
  );

  return <DescribeContext.Provider value={value}>{children}</DescribeContext.Provider>;
}

export function useDescribe(): DescribeState {
  const ctx = React.useContext(DescribeContext);
  if (!ctx) {
    throw new Error("useDescribe must be used inside DescribeProvider");
  }
  return ctx;
}

"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import { SelectState } from "@/components/create/select-state";
import { WatchState } from "@/components/create/watch-state";
import { seedsFor, useRunStream, type Seed } from "@/components/create/use-run-stream";
import { liveTopicSlugs } from "@/components/create/row-status";
import { brandHref } from "@/lib/orgs-context";
import { useRuns } from "@/lib/runs-context";
import { factsBuildOf, useFactsGen } from "@/lib/use-facts-gen";
import { hasEnded, isLive, runStateOf } from "@/lib/sessions";
import type { BlogSummary, RoadmapResponse, RunState } from "@/types";

type LiveRun = {
  runId: string;
  seeds: Seed[];
  /**
   * Where the ENGINE says this run sits against CLIENT_LOCK, kept in step with the run list
   * below. It starts "queued" because register_run does: a run is queued from the instant of
   * POST until it takes the lock, and assuming otherwise is how this view came to announce a
   * run in progress over a session that had not started.
   */
  state: RunState;
  /**
   * When the operator SUBMITTED this run, taken from the engine's own record. Elapsed is
   * measured from the engine's timestamps, so a refresh twenty minutes in still reads twenty
   * minutes: a start time kept in the browser would reset to zero and tell the operator a long
   * run had just begun. This one feeds the WAITING clock only.
   */
  submittedAt: string;
  /** When the engine took the lock and work began. Null while queued. The RUNNING clock. */
  runningSince: string | null;
};

const NO_SEEDS: Seed[] = [];

/**
 * Everything that belongs to one BRAND: its roadmap, its selection, its run.
 *
 * Blog creation is brand scoped and never global. A blog without a brand has no facts, no
 * roadmap, so there is no global create page for this to serve. The
 * org and brand arrive as props and are never read from a context or the URL: the route owns
 * that, and a component that guesses its own brand is how a blog gets written against the
 * wrong fact base.
 *
 * The route mounts this under `key={brandSlug}`, so switching brand is a fresh mount rather
 * than a hand written reset of five pieces of state that must not leak across brands.
 */
export function CreateForBrand({
  orgSlug,
  brandSlug,
  brandName,
  hasCanonicalFacts,
  resourceCount,
  demoMode,
  geoMock,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  /**
   * Whether this brand's canonical-facts.md exists, and how many resources it holds. Both come
   * from the client record the route already has, so the warning below costs no fetch of its
   * own: /api/clients carries has_canonical_facts and resource_count on every brand.
   */
  hasCanonicalFacts: boolean;
  resourceCount: number;
  demoMode: boolean;
  geoMock: boolean;
}) {
  const [roadmap, setRoadmap] = React.useState<RoadmapResponse | null>(null);
  const [roadmapError, setRoadmapError] = React.useState<ApiError | null>(null);
  const [blogs, setBlogs] = React.useState<BlogSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [run, setRun] = React.useState<LiveRun | null>(null);
  const [watching, setWatching] = React.useState(false);
  /**
   * A retry sends topics back to the roadmap ticked. The token forces a remount of the select
   * view, which is what lets its selection state start from these slugs: an effect that
   * re-ticked rows after mount would fight the operator every time they unticked one.
   */
  const [retry, setRetry] = React.useState<{ token: number; slugs: string[] } | null>(null);

  /**
   * The engine-wide run list, from the ONE poll above this tree rather than a read of its own.
   *
   * This used to fetch /api/runs once on mount, which was enough while the only question was
   * "is this brand mid run" and is not enough now that the answer distinguishes queued from
   * running. A run takes CLIENT_LOCK with no SSE frame on any channel this browser subscribes
   * to, so a one shot read would leave a session that started ten minutes ago still reading
   * "queued" until the operator refreshed. The same poll feeds the topbar and the Overview
   * card, so those three surfaces cannot disagree about the queue.
   */
  const { runs, error: runsError, checking: runsChecking } = useRuns();

  /**
   * This brand's fact base build, which a blog run starts and this browser only watches.
   *
   * Held HERE rather than inside the live view for the same reason the stream is: the view can
   * unmount, and the job cannot be the view's to own. It is read on mount rather than only after
   * a submit, because the build outlives the tab that triggered it: a refresh mid build, or a
   * second operator opening this page, has to see the same phase as the browser that pressed the
   * button.
   */
  const factsGen = useFactsGen(brandSlug);

  // The stream is held HERE rather than inside the live view, because the roadmap needs it
  // too: a topic in flight has to read as yellow on the table, and it has to be true while
  // the operator is looking at the table rather than the run.
  //
  // It stays attached while the run is QUEUED, which the Overview card deliberately does not
  // do, because this view owes the roadmap something that card does not: a queued run's topics
  // are in_flight to the engine (app.py gates that on `live`, which is true from POST), so
  // their rows must stay locked or the operator ticks them again and earns a 409. The feed on
  // a queued run is silent and harmless: app.py streams from each topic's status.jsonl, which
  // does not exist yet, so it sends heartbeats and nothing else. What must not happen is this
  // view DESCRIBING that silence as work, and WatchState branches on `state` so it does not.
  const stream = useRunStream(run?.runId ?? null, run?.seeds ?? NO_SEEDS);

  // The engine is an external system, so this subscribes to it and writes state from the
  // settled callback rather than synchronously inside an effect body.
  const loadBlogs = React.useCallback(
    (signal?: AbortSignal) =>
      api.blogs(brandSlug, signal).then(
        (data) => setBlogs(data.blogs),
        () => {
          // The blogs call only tints rows. Losing it must not cost the operator the
          // roadmap, and the engine still refuses a duplicate with a 409 either way.
        },
      ),
    [brandSlug],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function load() {
      try {
        const loaded = await api.roadmap(brandSlug, controller.signal);
        if (cancelled) {
          return;
        }
        setRoadmap(loaded);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setRoadmapError(
          cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
        );
      }

      await loadBlogs(controller.signal);

      if (!cancelled) {
        setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [brandSlug, loadBlogs]);

  const reloadRoadmap = React.useCallback(
    () =>
      api.roadmap(brandSlug).then(
        (loaded) => {
          setRoadmap(loaded);
          setRoadmapError(null);
        },
        (cause: unknown) => {
          setRoadmapError(
            cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
          );
        },
      ),
    [brandSlug],
  );

  /**
   * The engine's record for the run this view is attached to, or null once the engine forgets
   * it, which only a restart does.
   */
  const record = React.useMemo(
    () => (run === null ? null : (runs.find((r) => r.run_id === run.runId) ?? null)),
    [runs, run],
  );

  /**
   * Re-attach to a run this browser did not start.
   *
   * The run lives in the engine, not here. A refresh, a closed tab, or a machine that went to
   * sleep must not orphan the view, and operators share one deployment: a run started by one
   * of them is live on the server for all of them. Nothing about a run is remembered in this
   * browser, because a browser can only remember its own actions, which is the wrong scope for
   * a fact the server owns.
   *
   * Held until the roadmap settles, because seeds bind once: attaching while the CSV is in
   * flight would freeze every topic's name as its slug for the life of the run, and the labels
   * an operator recognises are their own H1s.
   */
  const settled = !loading && !runsChecking;
  const attachable =
    settled && run === null
      ? (runs.find((r) => isLive(r) && r.client === brandSlug) ?? null)
      : null;
  if (attachable !== null) {
    setRun({
      runId: attachable.run_id,
      seeds: seedsFor(attachable.topics, roadmap?.rows ?? []),
      state: runStateOf(attachable),
      submittedAt: attachable.started,
      runningSince: attachable.started_running,
    });
    setWatching(true);
  }

  /**
   * The engine's own answer overrides whatever this view assumed. Adjusting state during
   * render is React's answer to external state invalidating local state, and it settles in one
   * pass: these three fields only change when the engine's record changes, which for a given
   * run happens exactly once, when it takes CLIENT_LOCK.
   */
  if (run !== null && record !== null) {
    const state = runStateOf(record);
    if (
      run.state !== state ||
      run.submittedAt !== record.started ||
      run.runningSince !== record.started_running
    ) {
      setRun({ ...run, state, submittedAt: record.started, runningSince: record.started_running });
    }
  }

  // Either authority may say the run ended. The stream's closing frame usually wins; the run
  // list is the backstop, because a missed frame would otherwise leave every row on this
  // roadmap locked yellow against a run the engine finished long ago.
  //
  // A STOPPED run has no closing frame to miss. The engine writes a terminal line for the topics
  // that were in flight and none for the ones still behind the slots, so the stream can stay open
  // forever on a brand that halted, and the run list is the only thing that knows. Without this
  // arm a stop would leave every row on this roadmap locked yellow permanently, and the operator
  // could not resubmit the very topics the stop exists to hand back to them.
  const finished = stream.finished || (run !== null && hasEnded(run.state));

  // A finished run moved the ledger and wrote blogs to disk, so the roadmap's
  // already_generated flags and the failed set are both stale. Re-read them, which is what
  // turns the rows that just shipped green and the ones that died red.
  React.useEffect(() => {
    if (!finished) {
      return;
    }
    void reloadRoadmap();
    void loadBlogs();
  }, [finished, reloadRoadmap, loadBlogs]);

  const live = React.useMemo(
    () => liveTopicSlugs(stream.topics, finished),
    [stream.topics, finished],
  );
  const failed = React.useMemo(
    () => new Set(blogs.filter((b) => b.status === "failed").map((b) => b.topic_slug)),
    [blogs],
  );
  // Held blogs: they own a blog.md but sit off the ledger waiting for an operator answer, so
  // they are neither generated nor failed. Without this the row would show as a plain, tickable
  // "ready" and the operator would never learn a human owes it something first.
  const needsReview = React.useMemo(
    () => new Set(blogs.filter((b) => b.status === "needs_review").map((b) => b.topic_slug)),
    [blogs],
  );

  if (run && watching) {
    return (
      <WatchState
        runId={run.runId}
        state={run.state}
        // Resolved against THIS run's id, so a build the engine still holds from an earlier run
        // cannot put a live phase over a run that is past it.
        factsBuild={factsBuildOf(run.runId, factsGen.job)}
        submittedAt={run.submittedAt}
        runningSince={run.runningSince}
        stream={stream}
        blogsHref={brandHref(orgSlug, brandSlug, "/blogs")}
        onBack={() => {
          setWatching(false);
          // The ledger moves while a run is going, so the flags on screen are already stale.
          void reloadRoadmap();
          void loadBlogs();
        }}
        onRetry={(topicSlug) => {
          setRetry({ token: Date.now(), slugs: [topicSlug] });
          setWatching(false);
          void reloadRoadmap();
          void loadBlogs();
        }}
      />
    );
  }

  return (
    <SelectState
      key={`${roadmap?.upload_id ?? "no-roadmap"}:${retry?.token ?? 0}`}
      brandSlug={brandSlug}
      brandName={brandName}
      brandHref={brandHref(orgSlug, brandSlug)}
      // The route owns every URL in this tree. SelectState links out to the Content Roadmap
      // tab rather than building the path itself, for the same reason it takes brandSlug as a
      // prop: a component that derives its own routes can point at the wrong brand.
      roadmapHref={brandHref(orgSlug, brandSlug, "/roadmap")}
      resourcesHref={brandHref(orgSlug, brandSlug, "/resources")}
      hasCanonicalFacts={hasCanonicalFacts}
      resourceCount={resourceCount}
      demoMode={demoMode}
      geoMock={geoMock}
      roadmap={roadmap}
      roadmapError={roadmapError}
      // The run list is part of being loaded, not a detail behind it: rendering a tickable
      // roadmap before the engine has said whether this brand is mid run offers the operator
      // rows that are already in flight, and then swaps the view under them once the answer
      // lands. It used to be covered because the runs read lived inside this view's own load.
      loading={loading || runsChecking}
      live={live}
      failed={failed}
      needsReview={needsReview}
      // Not knowing is different from knowing there is no run, and the difference matters: a
      // live run this view missed leaves rows selectable that the engine will refuse. Say so
      // rather than imply an idle brand. The engine stays the backstop either way, since it
      // answers a resubmitted in-flight topic with a 409.
      runsUnavailable={runsError !== null}
      liveRunId={run && !finished ? run.runId : null}
      preselectSlugs={retry?.slugs}
      onWatch={() => setWatching(true)}
      onStarted={(runId, seeds) => {
        // QUEUED, not running, and that is not a guess: runner.py's register_run marks every
        // run queued at the instant the POST lands, and only CLIENT_LOCK promotes it. On an
        // idle engine that is over in milliseconds and the next poll says so. Assuming the
        // happy case here instead would put "Run in progress" over a session that may sit
        // behind another brand for twenty minutes.
        //
        // The 202 does not carry the engine's own `started`, so this stamps the instant it
        // accepted the run. The engine registered it microseconds earlier on this same
        // machine, and the run record replaces this the moment the poll sees it.
        setRun({
          runId,
          seeds,
          state: "queued",
          submittedAt: new Date().toISOString(),
          runningSince: null,
        });
        // This run may have just started a fact base build, and the poll stopped looking the
        // moment it read a settled job or a 404, which is exactly what a brand with no fact base
        // answers with until the instant one begins. Asking again is what turns the live view
        // into the facts phase rather than an empty topic list that reads as a stall.
        factsGen.recheck();
        setWatching(true);
      }}
    />
  );
}

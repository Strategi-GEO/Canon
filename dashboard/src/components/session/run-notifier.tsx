"use client";

import * as React from "react";
import { useNotifications } from "@/lib/notifications-context";
import { observeRuns, runFinishEdges } from "@/lib/notifications";
import { useRuns } from "@/lib/runs-context";
import type { RunState } from "@/types";

/**
 * Announces a blog run finishing, on every route.
 *
 * Headless, mounted once by the shell, exactly like DocumentTitle: it renders nothing and exists
 * to turn one engine fact into one notification. It is a component rather than a hook inside the
 * sink so the sink stays a sink, knowing nothing about runs.
 *
 * WHY IT DERIVES FROM THE EXISTING POLL AND NEVER ADDS ONE. lib/runs-context is the single read
 * of GET /api/runs for the whole app, and two reads of one list is the shape that grew a phantom
 * row in this codebase before. This watches the array that poll already produces.
 *
 * WHY THE POLL AND NOT THE SSE STREAM, which is faster and which the Create tab prefers: the run
 * frame is emitted only once every topic has written a terminal status line, so a run that dies
 * without writing them never emits it, while the engine's finish_run always runs and the list
 * always reflects it. This one accepts four seconds of latency to take the authority that cannot
 * miss the event it exists to report.
 */
export function RunNotifier() {
  const { runs, checking, error } = useRuns();
  const { notify } = useNotifications();

  /**
   * What this tab has watched, for the next reading to diff against. A ref, not state: it is a
   * record of observations and writing it must never schedule a render.
   *
   * Null until the first successful read, which is the whole defence against a bell that screams
   * on load. The engine never prunes its run dict, so the list carries every run since uvicorn
   * started, all finished; without a baseline, first paint would fire one toast per run and do it
   * again on every refresh.
   */
  const observed = React.useRef<Map<string, RunState> | null>(null);
  // Written in an effect, never during render: a ref is not render data, and the watcher below
  // only reads it after commit.
  const notifyRef = React.useRef(notify);
  React.useEffect(() => {
    notifyRef.current = notify;
  });

  React.useEffect(() => {
    // Nothing known yet, and an unread list is not an empty one. Baselining against a list that
    // failed to load would mark every live run unseen, and the next successful read would then
    // announce runs that had been running all along.
    if (checking || error !== null) {
      return;
    }

    const before = observed.current;
    observed.current = observeRuns(runs);

    if (before === null) {
      // The first sighting is history, not news. A run already finished when this tab opened
      // finished without the operator here, and the Blogs tab is where that lives.
      return;
    }

    for (const run of runFinishEdges(before, runs)) {
      notifyRef.current({
        kind: "run",
        brandSlug: run.client,
        key: run.run_id,
        // Topics and nothing more. The run record carries no score and no per-topic status, so
        // this counts what the run held and links to the tab that owns what came of it.
        topicCount: run.topics.length,
      });
    }
  }, [runs, checking, error]);

  return null;
}

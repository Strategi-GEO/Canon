"use client";

/**
 * NO PROGRESS BAR AND NO PERCENTAGE. The argument is the same one at the top of
 * create/topic-progress.tsx and it is stronger here: a blog run at least reports stages, and a
 * roadmap generation is ONE agent session making an unknown number of tool calls, so there is
 * not even a stage list to count. Nothing on the wire could give a bar a denominator, so a bar
 * could only be invented. The elapsed clock is the honest number and it is the only one here.
 */

import * as React from "react";
import { CheckCircle2, Loader2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { FieldError, errorLines } from "@/components/clients/engine-error";
import { useNow } from "@/components/create/use-now";
import {
  NO_DENOMINATOR,
  SURVIVES_REFRESH,
  workingLine,
  type MockReason,
} from "@/components/roadmap/generation-copy";
import { ApiError, api } from "@/lib/api";
import { formatCount, formatElapsed } from "@/lib/format";
import type { RoadmapGenState } from "@/lib/use-roadmap-gen";
import type { RoadmapGenJob } from "@/types";

/**
 * The generation, on the tab that owns it: running with its clock, or settled with its report.
 *
 * The REPORT is the reason this is a card and not a toast. It carries what the agent pulled,
 * what it cut, what it could not read, and what it disputes, including rows it refused to plan
 * because canonical-facts.md forbids the claim. That last one is the most valuable sentence
 * the factory produces here, and a toast would destroy it four seconds later.
 */
export function RoadmapGeneration({
  brandSlug,
  brandName,
  mock,
  gen,
}: {
  brandSlug: string;
  brandName: string;
  mock: MockReason | null;
  /** Held by the tab, because the tab also has to re-read the CSV when this lands. */
  gen: RoadmapGenState;
}) {
  const { job } = gen;

  // The clock ticks only while the engine says the job is running. A settled job's elapsed is
  // a duration, and it comes off the engine's own two timestamps rather than from a timer.
  const now = useNow(job?.state === "running");

  if (job === null) {
    // A failed CHECK is not the same as there being nothing to check, and rendering nothing
    // for it would claim this brand has no generation when the truth is that nobody asked
    // successfully. A 404 never reaches here: the hook parks it as the real empty state.
    if (gen.error !== null) {
      return <CheckFailed error={gen.error} />;
    }
    // Nothing, not a placeholder. Most visits to this tab have never had a generation, and
    // furniture announcing the absence of one would be permanent noise on the page whose job
    // is the roadmap itself.
    return null;
  }

  if (job.state === "running") {
    return <Running job={job} brandName={brandName} mock={mock} now={now} />;
  }

  return <Settled job={job} brandSlug={brandSlug} onDismissed={gen.clear} />;
}

/**
 * Running, and the operator's questions are exactly two: is it alive, and can I leave. The
 * clock answers the first, from the ENGINE's `started`, so a refresh twenty minutes in still
 * reads twenty minutes. The durability line answers the second.
 */
function Running({
  job,
  brandName,
  mock,
  now,
}: {
  job: RoadmapGenJob;
  brandName: string;
  mock: MockReason | null;
  now: Date | null;
}) {
  const elapsed = now === null ? null : formatElapsed(job.started, now);

  return (
    <Card className="mt-4 border-review/25 bg-review-bg">
      <CardContent>
        {/* The elapsed is deliberately outside the live region: it ticks every second, and a
            region carrying it would recite the clock forever instead of announcing the one
            change that matters, which is the roadmap landing. */}
        <p className="sr-only" aria-live="polite">
          {`A roadmap generation is running for ${brandName}. It writes the roadmap when it finishes.`}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-review">
            <Loader2
              className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            Generating a content roadmap
          </p>
          {elapsed !== null ? (
            <span className="machine ml-auto shrink-0 text-xs text-muted-foreground">
              {elapsed} elapsed
            </span>
          ) : null}
        </div>

        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          {workingLine(mock, brandName)} {NO_DENOMINATOR}
        </p>
        <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          {SURVIVES_REFRESH} The roadmap and its report appear here when it lands.
        </p>

        <Inputs job={job} />
      </CardContent>
    </Card>
  );
}

/** Done or failed. Both end in the same place: the agent's own account of what it did. */
function Settled({
  job,
  brandSlug,
  onDismissed,
}: {
  job: RoadmapGenJob;
  brandSlug: string;
  onDismissed: () => void;
}) {
  const [dismissing, setDismissing] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function dismiss() {
    setDismissing(true);
    setError(null);
    try {
      await api.clearRoadmapGeneration(brandSlug);
      onDismissed();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setDismissing(false);
    }
  }

  const failed = job.state === "failed";
  // Both timestamps are the engine's, so this is the session's real duration rather than the
  // span some browser happened to watch.
  const took = job.finished === null ? null : formatElapsed(job.started, new Date(job.finished));

  return (
    <Card className={failed ? "mt-4 border-fail/25 bg-fail-bg" : "mt-4 border-ship/25 bg-ship-bg"}>
      <CardContent>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p
            className={
              failed
                ? "flex min-w-0 items-center gap-2 text-sm font-medium text-fail"
                : "flex min-w-0 items-center gap-2 text-sm font-medium text-ship"
            }
          >
            {failed ? (
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
            )}
            {failed ? "The roadmap generation failed" : "Roadmap generated"}
          </p>

          <span className="ml-auto flex shrink-0 items-center gap-2">
            {took !== null ? (
              <span className="machine text-xs text-muted-foreground">took {took}</span>
            ) : null}
            {/* Dismissable only because it is settled, and it DELETEs the job rather than
                hiding it locally: the report is the engine's record, so an operator who has
                read it and wants it gone is telling the engine, not this tab. A local hide
                would come back on the next refresh, which is the ghost this app does not do. */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss this generation report"
              disabled={dismissing}
              onClick={() => void dismiss()}
            >
              {dismissing ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
            </Button>
          </span>
        </div>

        <Landed job={job} />

        {/* The engine's own sentence, verbatim. It says what actually broke, and paraphrasing
            it would cost the operator the only thing that tells them what to do next. */}
        {job.error !== null ? (
          <p className="machine mt-2 max-w-2xl text-xs wrap-break-word text-fail" role="alert">
            {job.error}
          </p>
        ) : null}

        {job.report !== null && job.report.trim() !== "" ? (
          <div className="mt-4 rounded-md border border-border bg-card px-4 py-3">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              What the agent reported
            </p>
            {/* Rendered, not summarised. This is the agent's final message: what it pulled,
                what it cut, what yielded no text, and what it disputes about the result. */}
            <MarkdownView source={job.report} className="mt-2" />
          </div>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The session left no report. That is unusual: the report is the agent&apos;s final
            message, so a missing one means the session ended before it could write one.
          </p>
        )}

        <Inputs job={job} />

        {error ? <FieldError error={error} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * The engine did not answer, so whether a generation is running is unknown.
 *
 * One quiet line rather than a card: a failed check is not an emergency and this tab has a
 * roadmap to show. It must still be said, for the reason the session card says it: silence
 * here is indistinguishable from "no generation", and the operator's next move on that
 * reading is to start one the engine may then refuse. The engine's own words come through
 * untouched, because "cannot reach" and "refused" send them to two different places.
 */
function CheckFailed({ error }: { error: ApiError }) {
  return (
    <p className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 text-fail">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {error.isOffline
          ? "Cannot reach the engine, so a roadmap generation for this brand would not show here."
          : "The engine refused the generation check, so one running for this brand would not show here."}
      </span>
      <span className="machine wrap-break-word">{errorLines(error).join(" ")}</span>
    </p>
  );
}

/** What actually reached disk, which is a different question from whether the session ended. */
function Landed({ job }: { job: RoadmapGenJob }) {
  if (job.rows === null) {
    return (
      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        No roadmap was written. The agent is told to write nothing rather than guess when it
        cannot read enough to plan honestly, so the report below is the answer to why.
      </p>
    );
  }

  return (
    <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
      It wrote <span className="machine text-foreground">{formatCount(job.rows)}</span>{" "}
      {job.rows === 1 ? "topic" : "topics"} to the roadmap, counted by re-reading the file it
      left. {job.piece_count === job.rows ? null : `You asked for ${job.piece_count}: the agent delivers fewer when fewer topics survive its own gates, and the report says why.`}
    </p>
  );
}

/**
 * The inputs the job was started with, echoed from the ENGINE's record rather than from the
 * form. A job read after a refresh, in another tab, or by another operator has no form behind
 * it, and "which URL did this actually research" is the first thing worth checking about a
 * roadmap that came back wrong.
 */
function Inputs({ job }: { job: RoadmapGenJob }) {
  return (
    <dl className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <div className="flex min-w-0 items-baseline gap-1.5">
        <dt>Researched from</dt>
        <dd className="machine min-w-0 wrap-anywhere text-foreground">{job.brand_url}</dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt>Asked for</dt>
        <dd className="machine text-foreground">
          {job.piece_count} {job.piece_count === 1 ? "piece" : "pieces"}
        </dd>
      </div>
      {job.mock ? (
        // Said on the artifact itself, not only on the button that made it. A mock roadmap
        // that reads as a researched one is the single most expensive confusion available
        // here: every blog for this brand would then be written from invented topics.
        <div className="flex items-baseline gap-1.5">
          <dt className="sr-only">Mode</dt>
          <dd className="text-review">mock rows, nothing live was called</dd>
        </div>
      ) : null}
      {job.notes.trim() !== "" ? (
        <div className="flex min-w-0 basis-full items-baseline gap-1.5">
          <dt className="shrink-0">Notes</dt>
          <dd className="min-w-0 text-pretty text-foreground">{job.notes}</dd>
        </div>
      ) : null}
    </dl>
  );
}

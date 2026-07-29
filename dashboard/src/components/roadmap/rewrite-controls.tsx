"use client";

import * as React from "react";
import { CheckCircle2, Loader2, RefreshCcw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ViewInstructionsButton } from "@/components/instructions-viewer";
import { FieldError } from "@/components/clients/engine-error";
import { useNow } from "@/components/create/use-now";
import { ApiError, api } from "@/lib/api";
import { formatCount, formatElapsed } from "@/lib/format";
import type { RewriteJob } from "@/types";

/** Rows as the operator reads them: 1-based, comma-joined. */
function rowNumbers(indices: number[]): string {
  return indices.map((i) => i + 1).join(", ");
}

/**
 * Why a blog on disk locks its row against rewriting, per blog status. ANY blog locks: it was
 * written from the row's brief and joins it by topic_slug, so replacing the row would orphan
 * the article. The engine 422s exactly this set; saying it on the checkbox beats offering a
 * click that can only be refused. The sentence also names the way out.
 */
const LOCKED_REASONS: Record<string, string> = {
  done: "This topic's blog shipped. Delete the blog on the Blogs page first if you truly want to replace the topic.",
  needs_review:
    "This topic's blog is waiting on your answer on the Blogs page, so the topic is locked while it holds.",
  failed:
    "This topic's blog failed and can be retried from Create Blogs. The topic is locked while the blog is on disk.",
  stopped:
    "This topic's blog was stopped mid-run and its work is kept on disk, so the topic is locked. Delete the blog to free it.",
  running: "This topic's blog is generating right now.",
};

/** A status this map has never heard of still locks the row; the engine would 422 it anyway. */
export function lockedReasonFor(status: string): string {
  return (
    LOCKED_REASONS[status] ??
    "This topic has a blog on disk, so it is locked: rewriting the row would orphan the article."
  );
}

/**
 * The rewrite bar under the preview grid: the batches in flight, and the next batch's
 * feedback and button. It appears only once something is ticked or something is running, so
 * the ordinary preview stays exactly the reading surface it always was.
 *
 * ONE feedback box for the batch, not one per row: the admin's thought is a single
 * instruction, and rows are numbered on screen, so "Row 3: drop the comparison angle"
 * addresses one row inside the shared box. Feedback is required before the button enables,
 * by the operator's own spec: the point of a rewrite is the correction it carries.
 */
export function RewriteControls({
  brandSlug,
  jobs,
  selected,
  onStarted,
  onCleared,
  onDeselect,
  locked,
  lockedReason,
}: {
  brandSlug: string;
  jobs: RewriteJob[];
  selected: ReadonlySet<number>;
  /** The 202's batch, adopted into the poll so its rows lock and its clock starts. */
  onStarted: (job: RewriteJob) => void;
  /** A settled batch was dismissed on the engine; the owner drops it from the list. */
  onCleared: (jobId: string) => void;
  /** Clears the tick set after a successful start: those ticks are spent. */
  onDeselect: () => void;
  /** True while a run is live or a generation is running: the engine would 409 the POST. */
  locked: boolean;
  lockedReason?: string;
}) {
  const [feedback, setFeedback] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const anyRunning = jobs.some((job) => job.state === "running");
  const now = useNow(anyRunning);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.rewriteRoadmap(brandSlug, {
        row_indices: [...selected].sort((a, b) => a - b),
        feedback: feedback.trim(),
      });
      // Ticks and box clear because they are SPENT: the batch now carries them and renders
      // above, and a box still holding the old feedback would invite resubmitting it
      // against rows that no longer need it. The NEXT batch starts clean.
      setFeedback("");
      onDeselect();
      onStarted(job);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSubmitting(false);
    }
  }

  if (jobs.length === 0 && selected.size === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {jobs.map((job) => (
        <Batch key={job.id} job={job} now={now} brandSlug={brandSlug} onCleared={onCleared} />
      ))}

      {selected.size > 0 ? (
        <form onSubmit={submit} className="rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-56 flex-1">
              <label
                htmlFor="rewrite-feedback"
                className="text-xs font-medium text-foreground"
              >
                {`What is wrong with ${selected.size === 1 ? "this topic" : "these topics"} (rows ${rowNumbers([...selected].sort((a, b) => a - b))})`}
              </label>
              <Textarea
                id="rewrite-feedback"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={2}
                placeholder="Too top-of-funnel. Go bottom-of-funnel, the buyer is ready to visit. Row 3: drop the comparison framing."
                className="mt-1.5 max-h-40 bg-card"
              />
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                One note for the batch, binding on the session that replaces exactly these
                rows. Every unticked row stays word for word and the total never changes. You
                can start another batch while this one runs.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5 pt-5">
              <Button
                type="submit"
                size="sm"
                disabled={submitting || locked || feedback.trim() === ""}
                title={
                  feedback.trim() === "" && !locked
                    ? "Say what is wrong first; the feedback is what the rewrite is for."
                    : undefined
                }
              >
                {submitting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                ) : (
                  <RefreshCcw data-icon="inline-start" aria-hidden />
                )}
                {`Rewrite ${formatCount(selected.size)} ${selected.size === 1 ? "topic" : "topics"}`}
              </Button>
              <p className="text-right text-[0.6875rem] text-muted-foreground">
                One research session; spends your Claude quota.
              </p>
            </div>
          </div>
          {locked && lockedReason ? (
            <p className="mt-2 text-xs leading-relaxed text-review">{lockedReason}</p>
          ) : null}
          {error ? <FieldError error={error} /> : null}
        </form>
      ) : null}
    </div>
  );
}

/** One batch's line: its rows, its state, its clock, its report, its dismiss. */
function Batch({
  job,
  now,
  brandSlug,
  onCleared,
}: {
  job: RewriteJob;
  now: Date | null;
  brandSlug: string;
  onCleared: (jobId: string) => void;
}) {
  const [dismissing, setDismissing] = React.useState(false);

  async function dismiss() {
    setDismissing(true);
    try {
      await api.clearRewriteJob(brandSlug, job.id);
      onCleared(job.id);
    } catch {
      // A failed dismiss keeps the line; the next click tries again. Nothing to explain
      // beyond the line still being there.
      setDismissing(false);
    }
  }

  const rows = rowNumbers(job.row_indices);
  const running = job.state === "running";
  const failed = job.state === "failed";
  const elapsed = running && now !== null ? formatElapsed(job.started, now) : null;

  return (
    <div
      className={
        failed
          ? "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-fail/25 bg-fail-bg px-3 py-2"
          : running
            ? "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-review/25 bg-review-bg px-3 py-2"
            : "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ship/25 bg-ship-bg px-3 py-2"
      }
    >
      <p
        className={
          failed
            ? "flex min-w-0 items-center gap-1.5 text-xs font-medium text-fail"
            : running
              ? "flex min-w-0 items-center gap-1.5 text-xs font-medium text-review"
              : "flex min-w-0 items-center gap-1.5 text-xs font-medium text-ship"
        }
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : failed ? (
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
        )}
        {running
          ? `Rewriting ${job.row_indices.length === 1 ? "row" : "rows"} ${rows}`
          : failed
            ? `The rewrite of ${job.row_indices.length === 1 ? "row" : "rows"} ${rows} failed`
            : `Replaced ${job.row_indices.length === 1 ? "row" : "rows"} ${rows}`}
      </p>

      {elapsed !== null ? (
        <span className="machine text-xs text-muted-foreground">{elapsed} elapsed</span>
      ) : null}

      {/* The engine's own sentence, verbatim: it says what actually refused the splice. */}
      {job.error !== null ? (
        <span className="machine min-w-0 flex-1 text-xs wrap-break-word text-fail" role="alert">
          {job.error}
        </span>
      ) : null}

      <span className="ml-auto flex shrink-0 items-center gap-1">
        {job.report !== null && job.report.trim() !== "" ? (
          // The agent's own account of the batch, in the shared markdown viewer: what it
          // pulled, what it cut, and what it disputes about its replacements.
          <ViewInstructionsButton
            title={`Rewrite of ${job.row_indices.length === 1 ? "row" : "rows"} ${rows}`}
            label="Report"
            variant="ghost"
            tabs={[{ value: "report", label: "Report", source: job.report }]}
          />
        ) : null}
        {!running ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Dismiss the rewrite of rows ${rows}`}
            disabled={dismissing}
            onClick={() => void dismiss()}
          >
            {dismissing ? <Loader2 className="animate-spin" aria-hidden /> : <X aria-hidden />}
          </Button>
        ) : null}
      </span>
    </div>
  );
}

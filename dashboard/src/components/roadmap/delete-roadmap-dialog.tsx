"use client";

import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { FieldError } from "@/components/clients/engine-error";
import { formatCount } from "@/lib/format";

/**
 * Deletes ONE month's roadmap, behind a confirm that says what is actually lost.
 *
 * A brand holds many monthly roadmaps now, so this deletes the ONE named by `month` and leaves
 * every other month standing.
 *
 * IT DELETES THAT MONTH'S BLOGS TOO, and this copy used to promise the opposite. It said "blogs
 * already written stay" over a route that kept them, and the route no longer does: a month is a
 * roadmap plus the blogs written from it, and the Blogs tab groups by month, so a month whose
 * sheet is gone could not be named or reached. Reassurance that has stopped being true is worse
 * than no reassurance at all, because it is exactly what an operator reads before pressing.
 *
 * The trigger is an icon in the preview sidebar, one per month, so it names the month it deletes
 * for a reader who cannot see which row a bare trash icon sits on.
 */
export function DeleteRoadmapDialog({
  brandSlug,
  month,
  label,
  rowCount,
  /** True while a run is live. The engine 409s the delete until it finishes. */
  locked,
  onDeleted,
}: {
  brandSlug: string;
  /** The 1-based month key this delete targets. */
  month: number;
  /** The operator-facing name of the month, e.g. "Month 3 Roadmap". */
  label: string;
  rowCount: number;
  locked: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function remove() {
    setSubmitting(true);
    setError(null);
    try {
      await api.deleteRoadmap(brandSlug, month);
      setOpen(false);
      onDeleted();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        {/* Ghost icon in the sidebar row, destructive only inside the confirm. This button opens
            a question; it destroys nothing, and the sr-only label names the month so it is not a
            row of anonymous trash cans to a screen reader. */}
        <Button size="icon-sm" variant="ghost" disabled={locked}>
          <Trash2 aria-hidden />
          <span className="sr-only">Delete {label}</span>
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes its topic list only. The{" "}
            <span className="machine">{formatCount(rowCount)}</span>{" "}
            {rowCount === 1 ? "topic" : "topics"} on this month{" "}
            {rowCount === 1 ? "stops" : "stop"} being listed, and no other month is touched.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Outside the description, and as a list, because this is the part that decides the
            answer. A description is read past; two lines under a heading are read. */}
        <div className="text-sm">
          <p className="font-medium text-fail">This month&apos;s blogs are deleted with it</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              Every blog written from this month&apos;s roadmap is deleted: its draft, its
              evaluation, its research and its history. This cannot be undone.
            </li>
            <li>
              That includes blogs already sent to a client or posted to a CMS. A post already
              live on a client&apos;s site is <span className="font-medium">not</span> taken
              down; only this app&apos;s record of it goes.
            </li>
            <li>
              The sheet itself is archived first, so the topic list can be recovered. The blogs
              cannot.
            </li>
          </ul>
        </div>

        {error ? <FieldError error={error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={submitting}>
            Keep it
          </AlertDialogCancel>
          {/* THE destructive action. onClick preventDefault holds the dialog open until the
              request settles, so a 409 lands in front of the operator instead of behind a dialog
              that has already closed. */}
          <AlertDialogAction
            size="sm"
            variant="destructive"
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            {submitting ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            Delete {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

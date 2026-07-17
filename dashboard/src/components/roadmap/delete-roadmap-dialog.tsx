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
 * Deletes the whole roadmap, behind a confirm that says what is actually lost.
 *
 * What is lost is the TOPIC LIST and nothing else. The engine removes roadmap.csv and leaves
 * every blog on disk and in the ledger, because a roadmap is the input and deleting an input
 * never destroys what it already produced. Saying that is not reassurance for its own sake: an
 * operator who thinks this destroys their blogs will not press it, and delete is the only way
 * to replace a roadmap, so a confirm that fails to explain itself is a dead end. The scary
 * dialog would be the honest one only if the danger were real, and it is not.
 *
 * What IS lost is stated too: hand-added records are in that CSV and nothing else holds them.
 */
export function DeleteRoadmapDialog({
  brandSlug,
  brandName,
  rowCount,
  generatedCount,
  /** True while a run is live. The engine 409s the delete until it finishes. */
  locked,
  onDeleted,
}: {
  brandSlug: string;
  brandName: string;
  rowCount: number;
  /** Rows whose blog already exists. The exact number this dialog promises to keep. */
  generatedCount: number;
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
      await api.deleteRoadmap(brandSlug);
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
        {/* Outline on the page, destructive only inside the confirm. This button opens a
            question; it destroys nothing, and a red button sitting permanently above the table
            would make the roadmap read as a hazard rather than as the brand's topic list. */}
        <Button size="sm" variant="outline" disabled={locked}>
          <Trash2 data-icon="inline-start" aria-hidden />
          Delete content roadmap
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the content roadmap for {brandName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the topic list only. The{" "}
            <span className="machine">{formatCount(rowCount)}</span>{" "}
            {rowCount === 1 ? "topic" : "topics"} on this roadmap{" "}
            {rowCount === 1 ? "stops" : "stop"} being listed, and nothing else is touched.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Outside the description, and as a list, because this is the part that decides the
            answer. A description is read past; two lines under a heading are read. */}
        <div className="text-sm">
          <p className="font-medium text-foreground">Blogs already written stay</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              Every blog is on disk and in the ledger, and both survive this. They stay in the
              Blogs library for {brandName}, readable and unchanged.
              {generatedCount > 0 ? (
                <>
                  {" "}
                  <span className="machine">{formatCount(generatedCount)}</span> of the topics
                  on this roadmap {generatedCount === 1 ? "has" : "have"} a blog, and{" "}
                  {generatedCount === 1 ? "it keeps" : "all of them keep"} theirs.
                </>
              ) : null}
            </li>
            <li>
              The roadmap is the input, not the work. Deleting it costs you the list of what to
              write next, never anything already written.
            </li>
            <li>
              Uploading a new roadmap needs this gone first, which is what this button is for.
              The sheet on your own machine is untouched, so the way back is to upload it again.
            </li>
          </ul>
        </div>

        {error ? <FieldError error={error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={submitting}>
            Keep the roadmap
          </AlertDialogCancel>
          {/* THE destructive action, and one of the two places in this app that variant belongs:
              a sheet is genuinely about to be deleted. The other is the stop confirm on the
              session card, which throws away work in flight without deleting a file. Both are
              destructive of something the operator cannot get back by pressing again, and that is
              the whole of the test. onClick preventDefault holds the dialog
              open until the request settles, so a 409 lands in front of the operator instead of
              behind a dialog that has already closed. */}
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
            Delete the roadmap
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

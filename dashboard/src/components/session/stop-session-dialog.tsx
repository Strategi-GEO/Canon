"use client";

import * as React from "react";
import { CircleStop, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import { formatCount } from "@/lib/format";

/**
 * Stops a brand's blog generation, behind a confirm that says what actually happens to the work.
 *
 * The confirm is not ceremony. This is the only irreversible-looking button in the app, it sits
 * next to a run the operator has been watching for twenty minutes, and the fear it has to answer
 * is specific: that stopping throws away the blogs. It does not. Finished blogs are kept, in
 * flight ones are marked stopped and never ship, queued topics never start, and NOTHING is
 * deleted from disk. A stopped topic keeps its research, which is why picking it back up is
 * cheap and why an honest dialog makes this button pressable at all. A dialog that only said
 * "are you sure?" would leave the operator to guess, and the safe guess is not to press it: they
 * would sit and watch an hour of sessions they had already decided against.
 *
 * BRAND-SCOPED, which is the operator's own choice of scope: one press stops everything for this
 * brand. A per-session stop would have them press it once per session while the queue moved
 * underneath them, and the thing they want stopped is the brand, not a run id.
 */
export function StopSessionDialog({
  brandName,
  brandSlug,
  /** Topics already in a terminal state. The exact number this dialog promises to keep. */
  kept,
  /** Topics in flight right now. The exact number this dialog promises to discard. */
  discarded,
  /** Topics that have not started. They never will, and they cost nothing. */
  neverStart,
}: {
  brandName: string;
  brandSlug: string;
  kept: number;
  discarded: number;
  neverStart: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function stop() {
    setSubmitting(true);
    setError(null);
    try {
      await api.stopRuns(brandSlug);
      setOpen(false);
      /**
       * The toast carries no counts, and the response's own summary is deliberately not read.
       * The stop is idempotent, so an honest answer to a second press is "0 runs stopped", and a
       * toast reading that over a brand that genuinely halted would be worse than saying nothing.
       * What changed is on screen within one poll anyway: the card is watching the run list.
       */
      toast.success(`Stopped ${brandName}`, {
        description:
          "Blogs that finished are kept. Nothing was deleted. Generate again to pick the rest back up.",
      });
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
        {/* Outline on the card, destructive only inside the confirm. This button opens a
            question and stops nothing on its own, and a red button sitting permanently on a
            healthy run would make a working batch read as a hazard. The X icon is already the
            dismiss on this same card, so a stop wearing it would be two acts under one glyph. */}
        <Button size="sm" variant="outline">
          <CircleStop data-icon="inline-start" aria-hidden />
          Stop
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop generating blogs for {brandName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This stops everything for {brandName}: the session running now and anything queued
            behind it. Other brands keep running.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Outside the description, and as a list, because this is the part that decides the
            answer. A description is read past; three lines under a heading are read. The order is
            the operator's own: what is kept first, because that is the fear. */}
        <div className="text-sm">
          <p className="font-medium text-foreground">Nothing is deleted</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              Blogs that have finished are kept, on disk and in the ledger, exactly as they are.
              They stay in the Blogs library for {brandName} and this does not touch them.
              {kept > 0 ? (
                <>
                  {" "}
                  <span className="machine">{formatCount(kept)}</span>{" "}
                  {kept === 1 ? "blog in this session has" : "blogs in this session have"}{" "}
                  finished, and {kept === 1 ? "it stays" : "they all stay"}.
                </>
              ) : null}
            </li>
            <li>
              Blogs being written right now are discarded: they stop where they are and they never
              ship. Their files stay on disk, so the research already done is still there and
              generating the topic again picks it up rather than starting over.
              {discarded > 0 ? (
                <>
                  {" "}
                  <span className="machine">{formatCount(discarded)}</span>{" "}
                  {discarded === 1 ? "blog is" : "blogs are"} in flight and{" "}
                  {discarded === 1 ? "it stops" : "they stop"} here.
                </>
              ) : null}
            </li>
            <li>
              Topics that have not started never start, and they cost nothing.
              {neverStart > 0 ? (
                <>
                  {" "}
                  <span className="machine">{formatCount(neverStart)}</span>{" "}
                  {neverStart === 1 ? "topic has" : "topics have"} not begun.
                </>
              ) : null}{" "}
              The whole brand halts, and Generate is the way to start it again.
            </li>
          </ul>
        </div>

        {error ? <FieldError error={error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={submitting}>
            Keep it running
          </AlertDialogCancel>
          {/* Destructive, and the second place in this app that variant belongs: work in flight
              is genuinely about to be thrown away, even though no file is. onClick preventDefault
              holds the dialog open until the request settles, so the engine's refusal lands in
              front of the operator instead of behind a dialog that has already closed. */}
          <AlertDialogAction
            size="sm"
            variant="destructive"
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void stop();
            }}
          >
            {submitting ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            Stop the session
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

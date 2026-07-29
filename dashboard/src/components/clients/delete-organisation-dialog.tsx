"use client";

import * as React from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";

/**
 * The two-gate confirm for HARD-deleting a brand from Settings. The delete is irreversible (it
 * cascades every blog, post, roadmap and resource and purges the brand's files), so one
 * are-you-sure is not enough: the operator passes two locks in sequence.
 *
 *   1. CONSENT: tick "I understand ..." to unlock Continue.
 *   2. CONFIRM: retype the exact slug to unlock the delete.
 *
 * The phase only advances on an explicit click, and closing the dialog resets both gates, so an
 * accidental reopen always starts from the beginning. On success it calls onDeleted, which the
 * caller uses to navigate away from the now-deleted brand's pages.
 */
export function DeleteOrganisationDialog({
  slug,
  name,
  onDeleted,
}: {
  slug: string;
  name: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [phase, setPhase] = React.useState<"consent" | "confirm">("consent");
  const [agreed, setAgreed] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  function reset() {
    setPhase("consent");
    setAgreed(false);
    setTyped("");
    setError(null);
    setSubmitting(false);
  }

  async function remove() {
    setSubmitting(true);
    setError(null);
    try {
      await api.deleteClient(slug);
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
        if (!next) reset();
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <Trash2 data-icon="inline-start" aria-hidden />
          Delete this brand
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        {phase === "consent" ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently deletes {name} and everything under it: every blog with its
                versions and comments, every LinkedIn and Medium post, the roadmap, all reports and
                analyses, the uploaded resources, and its files on the machine running the engine.
                It cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-fail/25 bg-fail-bg p-3 text-sm text-foreground">
              <Checkbox
                checked={agreed}
                onCheckedChange={(value) => setAgreed(value === true)}
                className="mt-0.5"
                aria-label="I understand the consequences"
              />
              <span>
                I understand this permanently deletes {name} and everything in it, with no undo.
              </span>
            </label>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <Button
                size="sm"
                variant="destructive"
                disabled={!agreed}
                onClick={() => setPhase("confirm")}
              >
                Continue
              </Button>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Type the slug to confirm</AlertDialogTitle>
              <AlertDialogDescription>
                This is the last step and there is no undo after it. To delete {name} for good, type
                its slug{" "}
                <span className="machine font-semibold text-foreground">{slug}</span> below.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div>
              <Label htmlFor="delete-brand-slug" className="sr-only">
                Brand slug
              </Label>
              <Input
                id="delete-brand-slug"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoFocus
                spellCheck={false}
                placeholder={slug}
                className="machine"
              />
            </div>
            {error ? <FieldError error={error} /> : null}
            <AlertDialogFooter>
              <Button
                size="sm"
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  setError(null);
                  setPhase("consent");
                }}
              >
                Back
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={typed !== slug || submitting}
                onClick={() => void remove()}
              >
                {submitting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                ) : null}
                Delete {name} forever
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

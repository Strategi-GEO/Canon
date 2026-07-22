"use client";

import { Loader2, Trash2 } from "lucide-react";
import * as React from "react";

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
import { monthLabel } from "@/lib/reports";

/**
 * The are-you-sure for deleting a month's WORKING report. Destructive and irreversible from the
 * operator's side: there is no way to see the working copy again once it is gone. When the report
 * has been shared, the dialog says plainly that the client keeps seeing the shared copy, because
 * "delete does not delete it for the client" is the surprising half of this action.
 */
export function DeleteReportDialog({
  brandSlug,
  month,
  isShared,
  onDeleted,
}: {
  brandSlug: string;
  month: string;
  isShared: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function remove() {
    setSubmitting(true);
    setError(null);
    try {
      await api.deleteReport(brandSlug, month);
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
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2 aria-hidden data-icon="inline-start" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the {monthLabel(month)} report?</AlertDialogTitle>
          <AlertDialogDescription>
            {isShared
              ? "This removes your copy of the report. There is no way to see it again once it is gone, so you would have to regenerate it. The client keeps seeing the version you already shared, until you generate a new one and share that."
              : "This removes the report for this month. There is no way to see it again once it is gone, so you would have to regenerate it. It was never shared, so the client sees nothing either way."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FieldError error={error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={submitting}>
            Keep it
          </AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            variant="destructive"
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            {submitting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
            Delete report
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

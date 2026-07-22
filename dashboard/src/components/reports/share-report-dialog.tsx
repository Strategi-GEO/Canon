"use client";

import { Loader2, Send } from "lucide-react";
import * as React from "react";
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
import { monthLabel } from "@/lib/reports";

/**
 * Send a month's report to the client. Confirmed because it is outward facing: the moment it
 * lands the client can see it in their portal, and every share re-sends (so a re-share after a
 * regenerate replaces what they saw). `resend` softens the copy for the second time onward.
 */
export function ShareReportDialog({
  brandSlug,
  brandName,
  month,
  resend,
  onShared,
}: {
  brandSlug: string;
  brandName: string;
  month: string;
  resend: boolean;
  onShared: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function share() {
    setSubmitting(true);
    setError(null);
    try {
      await api.shareReport(brandSlug, month);
      setOpen(false);
      toast.success(resend ? "Report re-shared" : "Report shared with client", {
        description: `${brandName} can see the ${monthLabel(month)} report in their portal.`,
      });
      onShared();
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
        <Button size="sm">
          <Send aria-hidden data-icon="inline-start" />
          {resend ? "Share again" : "Send to client"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {resend ? "Share this version with the client?" : `Send the ${monthLabel(month)} report to the client?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resend
              ? `${brandName} is currently seeing an earlier version. Sharing replaces it with the report on screen now.`
              : `${brandName} will see this report in their portal, exactly as it looks here. You can regenerate and re-share later, and deleting your copy will not remove it from their portal.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FieldError error={error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={submitting}>
            Not yet
          </AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            disabled={submitting}
            onClick={(event) => {
              event.preventDefault();
              void share();
            }}
          >
            {submitting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
            {resend ? "Share again" : "Send to client"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

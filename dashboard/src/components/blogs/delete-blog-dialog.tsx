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

/**
 * The are-you-sure for deleting one blog from the library. Destructive: it removes the topic
 * from the record and drops its scratch, so the article, its versions and its comments are gone
 * and the roadmap row is free to generate again. The trigger is a per-row icon; the dialog owns
 * the confirm and the API call, and calls onDeleted so the library refetches.
 */
export function DeleteBlogDialog({
  brandSlug,
  topicSlug,
  title,
  onDeleted,
}: {
  brandSlug: string;
  topicSlug: string;
  title: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function remove() {
    setSubmitting(true);
    setError(null);
    try {
      await api.deleteBlog(brandSlug, topicSlug);
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
        {/* stopPropagation so opening the confirm does not also fire the row's navigate. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          onClick={(event) => event.stopPropagation()}
        >
          <Trash2 aria-hidden />
          <span className="sr-only">Delete {title}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent onClick={(event) => event.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this blog?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes &quot;{title}&quot; and its versions and comments. There is no undo. The
            roadmap row is freed, so you can generate or upload the topic again from scratch.
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
            {submitting ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            Delete blog
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

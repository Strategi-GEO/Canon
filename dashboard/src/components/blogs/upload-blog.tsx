"use client";

import * as React from "react";
import { FileUp, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import type { RoadmapRow, UploadBlogResult } from "@/types";
import type { RowState } from "@/components/create/row-status";

/** The ceiling the engine enforces, mirrored so an obvious mistake never costs a round trip. */
const MAX_BYTES = 1_000_000;

/**
 * Uploading a finished article against one roadmap topic, in place of generating it.
 *
 * WHY THIS EXISTS BESIDE GENERATE: not every blog is worth a research run. One may already be
 * written, commissioned, or carried over from another system, and the alternative to this
 * button is pasting an article into an editor that only opens once a blog already exists, or
 * spending a full pipeline run to rewrite work that is finished. An uploaded article lands in
 * admin review exactly where a generated one does, so everything after this point (the stage
 * page, the comment rail, Send to client) is the same road.
 *
 * WHAT THIS DOES NOT DO: it does not claim the article is good. The engine records no score
 * for it, writes no eval, and marks it uploaded wherever it is shown. The gates still run and
 * their report comes back with the response, but they are ADVISORY here and do not refuse the
 * upload: the operator wrote this elsewhere and is taking responsibility for it, and refusing
 * would hand them a file they cannot get into the app and no editor to fix it in. What the
 * dialog owes them is the report, plainly, which is what the success panel below is for.
 */
export function UploadBlog({
  brandSlug,
  row,
  state,
  onUploaded,
}: {
  brandSlug: string;
  row: RoadmapRow;
  /** How this row reads right now, which decides whether uploading is offered at all. */
  state: RowState;
  /** Fires once the article is committed, so the caller can refetch its rows and blogs. */
  onUploaded: (result: UploadBlogResult) => void;
}) {
  const [open, setOpen] = React.useState(false);

  // GATED ON HOSTED_READONLY AGAIN, and this time the route behind it refuses too. The hosted
  // site is a view-and-preview window: an admin reads blogs and their status there, and every
  // act that changes something happens in the Canon app. The real gate is server-side, in
  // app/api/clients/[slug]/blogs/[topic]/upload/route.ts, because a hidden button is not a gate
  // and this one exists only so an operator is never offered a control that would refuse them.
  //
  // NOTHING IS LOST BY HIDING IT WHOLE, unlike the Send control beside it. This component is a
  // button and its dialog and it carries no fact of its own: the roadmap row keeps rendering its
  // topic, its state and its ledger stamp with or without it, so an absent uploader on the
  // hosted build hides an act and hides no information.
  //
  // The gate sits after the hook rather than above it, matching PublishAction: an early return
  // ahead of useState reads as a conditionally called hook to the lint rule even when the flag
  // is a build-time constant that cannot change between renders.
  //
  // Sending the operator to the app also happens to be the honest answer for this act in
  // particular. gates.py is a subprocess and Vercel has none, so an article uploaded on the
  // hosted build could never be checked, only stored: the function returns
  // `gates: {ran: false, reason}` and can never return `passed: true`. Uploading from the app
  // gets the same article stored AND gated, which is the outcome the operator wanted anyway.
  if (HOSTED_READONLY) {
    return null;
  }

  const blocked = blockedReason(state);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A span wrapper because a disabled button fires no pointer events, so Radix would
              never see the hover and the reason would never open. */}
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-foreground"
              disabled={blocked !== null}
              onClick={() => setOpen(true)}
            >
              <FileUp aria-hidden />
              {/* Named, not "Upload": one sheet carries twenty five of these buttons, and the
                  topic is the only thing that tells them apart to a screen reader. */}
              <span className="sr-only">Upload a written article for {row.topic}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {blocked ?? `Upload a finished article for "${row.topic}" instead of generating it.`}
        </TooltipContent>
      </Tooltip>

      {/* Mounted only while open, so each upload starts on a clean file, error and report
          rather than showing the last one's outcome under a new topic's title. */}
      {open ? (
        <UploadDialog
          brandSlug={brandSlug}
          row={row}
          replacing={state === "generated"}
          onClose={() => setOpen(false)}
          onUploaded={onUploaded}
        />
      ) : null}
    </>
  );
}

function UploadDialog({
  brandSlug,
  row,
  replacing,
  onClose,
  onUploaded,
}: {
  brandSlug: string;
  row: RoadmapRow;
  /** This topic already has a blog, so a successful upload overwrites it. */
  replacing: boolean;
  onClose: () => void;
  onUploaded: (result: UploadBlogResult) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [result, setResult] = React.useState<UploadBlogResult | null>(null);
  const [over, setOver] = React.useState(false);
  // dragenter and dragleave fire for every child the pointer crosses, so a boolean set from
  // them flickers. Counting entries against leaves is what makes the state hold, exactly as
  // the roadmap uploader does it.
  const depth = React.useRef(0);

  function choose(picked: File | undefined) {
    if (!picked) {
      return;
    }
    setError(null);
    // Two checks only, and both are things the engine cannot do for us cheaply: that the file
    // looks like markdown, and that it is not absurdly large. Everything subtler (is there an
    // article in it, does it break a gate) is the engine's answer to give.
    if (!/\.(md|markdown|txt)$/i.test(picked.name)) {
      setError(
        new ApiError(
          0,
          `${picked.name} is not a markdown file. Upload the article as .md.`,
          null,
        ),
      );
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError(new ApiError(0, `${picked.name} is over 1 MB, which no blog is.`, null));
      return;
    }
    setFile(picked);
  }

  async function submit() {
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Read here rather than posting multipart: a markdown article is text, and this route
      // takes the same JSON body shape the manual save already takes.
      const text = await file.text();
      const uploaded = await api.uploadBlog(brandSlug, row.topic_slug, text, replacing);
      setResult(uploaded);
      toast.success(uploaded.replaced ? "Article replaced" : "Article uploaded", {
        description: `"${row.topic}" is in admin review with ${uploaded.word_count} words.`,
      });
      onUploaded(uploaded);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setBusy(false);
      // Clearing lets the operator re-pick the same filename after fixing the file.
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {result
              ? result.replaced
                ? "Article replaced"
                : "Article uploaded"
              : replacing
                ? "Replace the article for this topic?"
                : "Upload an article for this topic"}
          </DialogTitle>
          <DialogDescription>
            {result ? (
              <>
                &quot;{row.topic}&quot; is now in admin review. Open it from Blogs to edit it,
                comment on it, and send it to the client.
              </>
            ) : replacing ? (
              <>
                This topic already has a blog. Uploading replaces it with a new version, and
                any approval the client gave the old text no longer describes what they would
                see. The old version stays in the record.
              </>
            ) : (
              <>
                The article goes straight into admin review, exactly as a blog the factory
                wrote and shipped does. Nothing researches, gates or scores it first, so it
                carries no score and no dossier.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <GateReport result={result} />
        ) : (
          <>
            <input
              ref={inputRef}
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              className="sr-only"
              onChange={(event) => choose(event.target.files?.[0])}
            />

            {/* A real button, not a div with a click handler: it is reachable by keyboard and
                announced as a control without any aria plumbing. */}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDrop={(event) => {
                event.preventDefault();
                depth.current = 0;
                setOver(false);
                choose(event.dataTransfer.files?.[0]);
              }}
              // Without this the browser navigates to the dropped file and the page is lost.
              onDragOver={(event) => event.preventDefault()}
              onDragEnter={(event) => {
                event.preventDefault();
                depth.current += 1;
                setOver(true);
              }}
              onDragLeave={() => {
                depth.current -= 1;
                if (depth.current <= 0) {
                  depth.current = 0;
                  setOver(false);
                }
              }}
              className={cn(
                "flex w-full flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-center transition-colors",
                over ? "border-accent bg-accent/5" : "border-border hover:border-accent/60",
              )}
            >
              <FileUp className="size-5 text-muted-foreground" aria-hidden />
              <span className="text-sm font-medium text-foreground">
                {file ? file.name : "Choose a markdown file, or drop one here"}
              </span>
              <span className="text-xs text-muted-foreground">
                {file
                  ? `${(file.size / 1024).toFixed(0)} KB, ready to upload`
                  : "The article as .md, up to 1 MB"}
              </span>
            </button>
          </>
        )}

        {error ? <FieldError error={error} /> : null}

        <DialogFooter>
          {result ? (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy || !file} onClick={() => void submit()}>
                {busy ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                ) : null}
                {replacing ? "Replace it" : "Upload it"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the mechanical gates said, shown AFTER the article is already committed.
 *
 * That ordering is the design, not a compromise: see the module docstring. The panel is amber
 * rather than red because nothing failed, in the sense of anything being refused or lost. The
 * article is in review and editable; these are the house rules it does not currently meet, and
 * the operator decides whether to fix them in the stage editor or ship as written.
 */
function GateReport({ result }: { result: UploadBlogResult }) {
  const { gates } = result;

  if (!gates.ran) {
    return (
      <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        The mechanical gates could not run on this article
        {gates.reason ? `: ${gates.reason}` : ""}. The article is in review either way, and
        nothing has checked it for banned phrases, dashes or word count.
      </p>
    );
  }

  if (gates.passed) {
    return (
      <p className="rounded-md border border-ship/25 bg-ship/10 p-3 text-xs text-ship">
        {result.word_count} words, and every mechanical gate passes.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-review/25 bg-review-bg p-3">
      <p className="flex items-center gap-2 text-xs font-medium text-review">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {gates.failures.length} mechanical{" "}
        {gates.failures.length === 1 ? "gate fails" : "gates fail"} on this article
      </p>
      <ul className="mt-2 space-y-1">
        {gates.failures.map((line) => (
          <li key={line} className="machine text-xs leading-relaxed wrap-break-word text-review/90">
            {line}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        The article is uploaded and in admin review regardless. Edit it on its stage page to
        clear these, or send it as written.
      </p>
    </div>
  );
}

/** Why this row cannot take an upload, or null when it can. Mirrors the engine's refusals. */
function blockedReason(state: RowState): string | null {
  if (state === "in_progress") {
    return "This topic is generating right now. Upload once the run finishes, so the engine's own writes are not raced.";
  }
  if (state === "needs_review") {
    return "This blog is held for an answer the evaluator asked for. Answer its questions before replacing it with an uploaded article.";
  }
  return null;
}

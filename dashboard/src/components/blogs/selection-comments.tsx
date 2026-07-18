"use client";

import * as React from "react";
import { Check, CircleDashed, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BlogComment } from "@/types";

/** How much rendered text travels with the selection on each side. Enough to place a
 *  passage that appears twice; small enough that the prompt stays about the selection. */
const CONTEXT_CHARS = 120;

export type SelectionDraft = {
  selected_text: string;
  instruction: string;
  context_before: string;
  context_after: string;
};

/**
 * The article, with a Google-Docs-style comment composer over it.
 *
 * Select any rendered text and a small card fades in under the selection: describe the
 * change, press "Make changes with Claude", and the engine rewrites that passage alone.
 * The selection captured here is RENDERED text (markdown syntax stripped by the renderer);
 * the engine's edit session receives it with its surrounding context and maps it back to
 * the markdown source itself, which is exactly the kind of fuzzy anchoring a model does
 * reliably and position arithmetic does not.
 *
 * `disabled` keeps the layer entirely off: the article renders, selections mean nothing.
 * The page decides when that is (hosted build, demo brand, a blog that is not done, edit
 * mode open).
 */
export function CommentableArticle({
  source,
  disabled,
  remaining,
  onSubmit,
}: {
  source: string;
  disabled: boolean;
  /** How many more changes may be filed right now (the 3-in-flight cap minus in flight). */
  remaining: number;
  onSubmit: (draft: SelectionDraft) => Promise<void>;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);
  const [draft, setDraft] = React.useState<{
    text: string;
    before: string;
    after: string;
    top: number;
    left: number;
  } | null>(null);
  const [instruction, setInstruction] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  const close = React.useCallback(() => {
    setDraft(null);
    setInstruction("");
    setSendError(null);
  }, []);

  React.useEffect(() => {
    if (draft === null) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [draft, close]);

  function onMouseUp(event: React.MouseEvent) {
    if (disabled || sending) {
      return;
    }
    // A click inside the composer is the operator typing, not a new selection.
    if (composerRef.current?.contains(event.target as Node)) {
      return;
    }
    // Read the selection after the browser has settled it: on mouseup the selection can
    // still be mid-update, and reading it synchronously captures yesterday's range.
    window.setTimeout(() => {
      const wrap = wrapRef.current;
      const selection = window.getSelection();
      if (!wrap || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        close();
        return;
      }
      const range = selection.getRangeAt(0);
      if (!wrap.contains(range.startContainer) || !wrap.contains(range.endContainer)) {
        return;
      }
      const text = selection.toString().trim();
      if (text === "") {
        close();
        return;
      }

      // Rendered text either side of the selection, via range arithmetic rather than an
      // indexOf that would land on the wrong copy of a repeated phrase.
      const pre = range.cloneRange();
      pre.selectNodeContents(wrap);
      pre.setEnd(range.startContainer, range.startOffset);
      const post = range.cloneRange();
      post.selectNodeContents(wrap);
      post.setStart(range.endContainer, range.endOffset);

      const rect = range.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      setDraft({
        text,
        before: pre.toString().replace(/\s+/g, " ").slice(-CONTEXT_CHARS).trimStart(),
        after: post.toString().replace(/\s+/g, " ").slice(0, CONTEXT_CHARS).trimEnd(),
        top: rect.bottom - wrapRect.top + 8,
        // Clamped so a selection at the right edge does not push the card off the page.
        left: Math.max(0, Math.min(rect.left - wrapRect.left, wrapRect.width - 360)),
      });
      setInstruction("");
      setSendError(null);
    }, 0);
  }

  async function submit() {
    if (draft === null || instruction.trim() === "") {
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await onSubmit({
        selected_text: draft.text,
        instruction: instruction.trim(),
        context_before: draft.before,
        context_after: draft.after,
      });
      close();
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      // The engine's own words, in the card the operator is looking at.
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  const full = remaining <= 0;

  return (
    <div ref={wrapRef} className="relative" onMouseUp={onMouseUp}>
      <MarkdownView source={source} variant="article" />

      {draft !== null ? (
        <div
          ref={composerRef}
          style={{ top: draft.top, left: draft.left }}
          className={cn(
            "absolute z-30 w-[22.5rem] max-w-full rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg",
            "animate-in fade-in-0 zoom-in-95 duration-150",
          )}
        >
          <p className="border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">
            <span className="line-clamp-2">{draft.text}</span>
          </p>
          <Textarea
            autoFocus
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={3}
            placeholder="What should change in this selection?"
            aria-label="Describe the change for the selected text"
            className="mt-2.5 text-sm"
            disabled={sending || full}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {full
              ? "Three changes are already in flight. Wait for one to land before filing another."
              : "Claude edits only the selected passage, then marks this change resolved."}
          </p>
          {sendError !== null ? (
            <p className="mt-1.5 text-xs wrap-anywhere text-fail">{sendError}</p>
          ) : null}
          <div className="mt-2.5 flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={close} disabled={sending}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={sending || full || instruction.trim() === ""}
            >
              {sending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : (
                <Sparkles data-icon="inline-start" aria-hidden />
              )}
              Make changes with Claude
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The change log under the article: every comment filed against this blog, the operator's
 * and the client's alike, applying ones with a live spinner, settled ones with what
 * happened, and the client's open suggestions with the Resolve with Claude button they wait
 * on. Dismissed comments are hidden rather than deleted: the record keeps them, and a log
 * of declined suggestions would drown the ones still owed an act. Renders nothing until a
 * visible comment exists, because an empty "Changes" box would only announce a feature.
 */
export function CommentsPanel({
  comments,
  onDismiss,
  onResolve,
}: {
  comments: BlogComment[];
  onDismiss: (comment: BlogComment) => void;
  /** Starts the Claude apply for one open or failed comment. The engine owns the cap. */
  onResolve: (comment: BlogComment) => void;
}) {
  const shown = comments.filter((comment) => comment.state !== "dismissed");
  if (shown.length === 0) {
    return null;
  }
  const inFlight = shown.filter((comment) => comment.state === "applying").length;

  return (
    <Card size="sm" className="mt-8">
      <CardContent className="flex flex-col gap-3 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium text-foreground">Changes with Claude</p>
          <p className="machine text-xs text-muted-foreground">
            {inFlight > 0 ? `${inFlight}/3 in flight` : `${shown.length} filed`}
          </p>
        </div>
        <ul className="flex flex-col divide-y">
          {shown.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              inFlight={inFlight}
              onDismiss={onDismiss}
              onResolve={onResolve}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CommentRow({
  comment,
  inFlight,
  onDismiss,
  onResolve,
}: {
  comment: BlogComment;
  /** How many applies are live right now, for the courtesy disable at the engine's cap. */
  inFlight: number;
  onDismiss: (comment: BlogComment) => void;
  onResolve: (comment: BlogComment) => void;
}) {
  // Open and failed both wait on the same act: point Claude at the passage. On a failed
  // comment the button is the retry, whichever side filed it.
  const resolvable = comment.state === "open" || comment.state === "failed";
  const capped = inFlight >= 3;

  return (
    <li className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
      <span className="mt-0.5 shrink-0">
        {comment.state === "applying" ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
        ) : comment.state === "resolved" ? (
          <Check className="size-3.5 text-ship" aria-hidden />
        ) : comment.state === "open" ? (
          // The review tone, not the fail one: an open suggestion is the client asking, and
          // the hollow circle says nothing has run yet.
          <CircleDashed className="size-3.5 text-review" aria-hidden />
        ) : (
          <TriangleAlert className="size-3.5 text-fail" aria-hidden />
        )}
        <span className="sr-only">{comment.state}</span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <AuthorChip author={comment.author} />
          <p className="line-clamp-1 min-w-0 text-xs text-muted-foreground">
            &ldquo;{comment.selected_text}&rdquo;
          </p>
        </div>
        <p className="mt-0.5 text-sm text-foreground">{comment.instruction}</p>
        {comment.state === "failed" && comment.error ? (
          // The engine's own sentence: it names why nothing was changed.
          <p className="mt-1 text-xs wrap-anywhere text-fail">{comment.error}</p>
        ) : null}
        <p className="machine mt-1 text-xs text-muted-foreground">
          {comment.state === "applying"
            ? `applying since ${formatRelative(comment.created)}`
            : comment.state === "open"
              ? // The words carry the obligation: an open client suggestion sits with the
                // admin, and "open" alone would read as somebody else's queue.
                comment.author === "client"
                ? `waiting on you since ${formatRelative(comment.created)}`
                : `open since ${formatRelative(comment.created)}`
              : `${comment.state} ${formatRelative(comment.finished ?? comment.created)}`}
        </p>
        {resolvable ? (
          <Button
            size="xs"
            variant="outline"
            className="mt-1.5"
            disabled={capped}
            title={
              capped
                ? "Three changes are already in flight. Wait for one to land before starting another."
                : undefined
            }
            onClick={() => onResolve(comment)}
          >
            <Sparkles data-icon="inline-start" aria-hidden />
            Resolve with Claude
          </Button>
        ) : null}
      </div>
      {comment.state !== "applying" ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Dismiss this change"
          onClick={() => onDismiss(comment)}
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </li>
  );
}

/**
 * Who filed the comment, said in words rather than colour: "client" is a suggestion from
 * the portal and "you" is this side's own edit, and the difference decides whether the row
 * is owed an act or merely reports one.
 */
function AuthorChip({ author }: { author: BlogComment["author"] }) {
  return (
    <span className="machine inline-flex h-4 shrink-0 items-center rounded border border-border bg-muted px-1 text-[0.625rem] leading-none text-muted-foreground">
      {author === "client" ? "client" : "you"}
    </span>
  );
}

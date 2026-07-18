"use client";

import * as React from "react";
import { Check, Clock, Eye, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownView } from "@/portal/markdown-view";
import { formatRelative } from "@/portal/format";
import { cn } from "@/lib/utils";
import type { PortalComment, PortalCommentState, SuggestBody } from "@/portal/types";

/** How much rendered text travels with the selection on each side. Enough to place a
 *  passage that appears twice; small enough that the note stays about the selection. */
const CONTEXT_CHARS = 120;

/**
 * The client's suggestion surface: the portal's OWN build of the selection composer the
 * admin dashboard has. The interaction is the same on purpose (select a passage, a card
 * fades in under it, describe the change) because both sides are annotating the same
 * article; the words are not. To a client a suggestion goes to the team, full stop:
 * nothing here edits the article, promises a turnaround, or names the machinery that
 * applies changes. The admin component is deliberately not imported, because one shared
 * component would keep leaking operator language across the client boundary.
 */
export function SuggestableArticle({
  source,
  active,
  onSubmit,
}: {
  source: string;
  /** Suggest mode. Off, the article is just an article: selections mean nothing, so a
   *  client copying a sentence for an email never trips a composer they did not ask for. */
  active: boolean;
  onSubmit: (draft: SuggestBody) => Promise<void>;
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

  // Leaving suggest mode hides any half-written card, DERIVED rather than reset from an
  // effect (the lint forbids the effect, and the derivation cannot flicker): the stored
  // draft simply stops being rendered, and every new selection already reseeds the
  // instruction and error, so nothing stale can resurface when suggest mode returns.
  const visibleDraft = active ? draft : null;

  React.useEffect(() => {
    if (visibleDraft === null) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visibleDraft, close]);

  function onMouseUp(event: React.MouseEvent) {
    if (!active || sending) {
      return;
    }
    // A click inside the composer is the client typing, not a new selection.
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
    if (visibleDraft === null || instruction.trim() === "") {
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await onSubmit({
        selected_text: visibleDraft.text,
        instruction: instruction.trim(),
        context_before: visibleDraft.before,
        context_after: visibleDraft.after,
      });
      close();
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      // The server's own words, in the card the client is looking at.
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <div ref={wrapRef} className="relative" onMouseUp={onMouseUp}>
      <MarkdownView source={source} />

      {visibleDraft !== null ? (
        <div
          ref={composerRef}
          style={{ top: visibleDraft.top, left: visibleDraft.left }}
          className={cn(
            "absolute z-30 w-[22.5rem] max-w-full rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg",
            "animate-in fade-in-0 zoom-in-95 duration-150",
          )}
        >
          <p className="border-l-2 border-primary/40 pl-2 text-xs text-muted-foreground">
            <span className="line-clamp-2">{visibleDraft.text}</span>
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
            placeholder="What should change here?"
            aria-label="Describe the change for the selected text"
            className="mt-2.5 text-sm"
            disabled={sending}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Your note goes to our team with this exact passage.
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
              disabled={sending || instruction.trim() === ""}
            >
              {sending ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : (
                <Send data-icon="inline-start" aria-hidden />
              )}
              Send to the team
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The record's states folded to the portal's three plain words. open and applying are both
 * simply "with the team": a suggestion the team has not settled yet. So is failed, and
 * that one is a rule, not a shortcut: a failed apply is the team's problem to retry or
 * settle, never the client's, so the client only ever learns the team still has it.
 * dismissed reads as "reviewed": the team read the note and kept the passage as it stands.
 */
function plainState(state: PortalCommentState): "with the team" | "addressed" | "reviewed" {
  if (state === "resolved") {
    return "addressed";
  }
  if (state === "dismissed") {
    return "reviewed";
  }
  return "with the team";
}

/**
 * The client's own suggestions under the article, each with where it stands in plain
 * language. Renders nothing until a suggestion exists, because an empty "Your suggestions"
 * box would only announce a feature.
 */
export function SuggestionsList({ comments }: { comments: PortalComment[] }) {
  if (comments.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Your suggestions"
      className="rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6"
    >
      <h2 className="text-sm font-semibold">Your suggestions</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Each one stays with our team until it is addressed or reviewed. The article above
        updates as changes are made.
      </p>
      <ul className="mt-4 flex flex-col divide-y">
        {comments.map((comment) => (
          <SuggestionRow key={comment.id} comment={comment} />
        ))}
      </ul>
    </section>
  );
}

function SuggestionRow({ comment }: { comment: PortalComment }) {
  const label = plainState(comment.state);
  return (
    <li className="flex gap-2.5 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 shrink-0">
        {label === "addressed" ? (
          <Check className="size-3.5 text-ship" aria-hidden />
        ) : label === "reviewed" ? (
          <Eye className="size-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <Clock className="size-3.5 text-muted-foreground" aria-hidden />
        )}
        <span className="sr-only">{label}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-xs text-muted-foreground">
          &ldquo;{comment.selected_text}&rdquo;
        </p>
        <p className="mt-0.5 text-sm text-pretty">{comment.instruction}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {label} · sent {formatRelative(comment.created)}
        </p>
      </div>
    </li>
  );
}

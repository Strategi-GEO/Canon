"use client";

import * as React from "react";
import {
  Check,
  CircleDashed,
  Link2Off,
  Loader2,
  Reply,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CommentRail, type RailComment } from "@/components/comments/rail";
import type { Anchor } from "@/components/comments/anchor";
import type { SelectionCapture } from "@/components/comments/selection";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { BlogComment } from "@/types";

/** The composer's id in the rail. Constant, because it is one card and it either exists or
 *  it does not; an id that changed with the selection would re-mark the whole article every
 *  time the operator dragged a word. */
const COMPOSER_ID = "composer";

export type SelectionDraft = {
  selected_text: string;
  instruction: string;
  context_before: string;
  context_after: string;
};

/**
 * The article with its comment rail: every change request beside the passage it annotates,
 * and a composer for filing the next one.
 *
 * BOTH SIDES OF THE REVIEW NOW READ THE SAME ARTICLE THE SAME WAY. The client comments from
 * their portal onto exactly these passages, and before the rail this side rendered their
 * words in a list under the article, so an operator resolving "cut this claim, we cannot
 * support it" had to hunt the draft for which claim. The rail answers that by construction:
 * the card is level with the sentence, hovering either raises the pair, and a comment whose
 * passage an edit has since rewritten says so on its own card rather than pointing nowhere.
 *
 * What this file owns is the CONTENT of those cards and nothing else. Layout, anchoring,
 * hover linkage and the touch-safe selection capture all live in components/comments, which
 * is shared with the portal and carries no product vocabulary at all. Everything here that
 * names Claude, a state, or an act stays here, because none of it is the client's language.
 *
 * `disabled` keeps the whole layer off: the article renders, selections mean nothing, and
 * with no comments to show there is no rail either. The page decides when that is (hosted
 * build, demo brand, a blog that is not done, edit mode open).
 */
export function CommentableArticle({
  source,
  comments,
  disabled,
  remaining,
  onSubmit,
  onDismiss,
  onResolve,
  onReply,
}: {
  source: string;
  /** Every comment the engine holds for this blog, dismissed ones included: the filtering
   *  is a decision this file makes, not one the caller should have to remember. */
  comments: BlogComment[];
  disabled: boolean;
  /** How many more changes may be filed right now (the 3-in-flight cap minus in flight). */
  remaining: number;
  onSubmit: (draft: SelectionDraft) => Promise<void>;
  onDismiss: (comment: BlogComment) => void;
  /** Starts the Claude apply for one open or failed comment. The engine owns the cap. */
  onResolve: (comment: BlogComment) => void;
  /** Files one operator reply in a comment's thread. Rejects with the engine's own sentence,
   *  which the card renders inline beside the box that produced it. */
  onReply: (comment: BlogComment, body: string) => Promise<void>;
}) {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [capture, setCapture] = React.useState<SelectionCapture | null>(null);
  const [instruction, setInstruction] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  /** Which cards lost their passage, straight from the rail's own measurement. */
  const [lost, setLost] = React.useState<ReadonlySet<string>>(() => new Set());

  // Dismissed comments are hidden rather than deleted: the record keeps them, because a
  // declined suggestion is part of the review trail, and a rail carrying every request the
  // team ever waved off would bury the ones still owed an act.
  const shown = React.useMemo(
    () => comments.filter((comment) => comment.state !== "dismissed"),
    [comments],
  );

  const close = React.useCallback(() => {
    setCapture(null);
    setInstruction("");
    setSendError(null);
    // The composer held the active id while it was open, and a card that no longer exists
    // cannot give it up: the rail would keep treating "composer" as chosen and no filed
    // comment could win its own anchor until something else was clicked.
    setActiveId((current) => (current === COMPOSER_ID ? null : current));
  }, []);

  React.useEffect(() => {
    if (capture === null) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [capture, close]);

  /**
   * A settled selection inside the article, or null when the reader cleared one.
   *
   * AN INSTRUCTION ALREADY TYPED IS NEVER DISCARDED HERE, in either direction. A stray click
   * on the article clears the browser's selection and would otherwise take three written
   * lines with it, and a fresh selection would otherwise move the composer to a passage the
   * written text is not about. So an EMPTY composer follows the selection, which is the
   * ordinary select-then-type path, and one holding text stays on its own passage until the
   * operator sends or cancels it. Its quoted passage is on the card in front of them, so
   * there is nothing to guess about which sentence they are writing about.
   */
  function onCapture(found: SelectionCapture | null) {
    if (instruction.trim() !== "") {
      return;
    }
    if (found === null) {
      close();
      return;
    }
    setCapture(found);
    setSendError(null);
  }

  const onAnchors = React.useCallback((anchors: Anchor[]) => {
    setLost((prev) => {
      const next = new Set(
        anchors.filter((anchor) => !anchor.found).map((anchor) => anchor.id),
      );
      // Same set, same object: the rail re-measures on every resize, and a fresh Set each
      // time would re-render every card on a window drag.
      if (next.size === prev.size && Array.from(next).every((id) => prev.has(id))) {
        return prev;
      }
      return next;
    });
  }, []);

  async function submit() {
    if (capture === null || instruction.trim() === "") {
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      await onSubmit({
        selected_text: capture.text,
        instruction: instruction.trim(),
        context_before: capture.before,
        context_after: capture.after,
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

  const cards = React.useMemo<RailComment[]>(
    () =>
      shown.map((comment) => ({
        id: comment.id,
        selected_text: comment.selected_text,
        body: (
          <CommentCard
            comment={comment}
            unanchored={lost.has(comment.id)}
            capped={full}
            onDismiss={onDismiss}
            onResolve={onResolve}
            onReply={onReply}
          />
        ),
      })),
    [shown, lost, full, onDismiss, onResolve, onReply],
  );

  const composer: RailComment | null =
    capture === null || disabled
      ? null
      : {
          id: COMPOSER_ID,
          // The live selection's own text, so the rail marks the passage through the same
          // pass every filed comment goes through. That mark is what keeps the passage
          // visibly highlighted after focus moves into the textarea and the browser's own
          // selection paint goes away.
          selected_text: capture.text,
          body: (
            <Composer
              passage={capture.text}
              instruction={instruction}
              sending={sending}
              full={full}
              error={sendError}
              onChange={setInstruction}
              onCancel={close}
              onSubmit={() => void submit()}
            />
          ),
        };

  // No rail where there is nothing to put in one: a read-only artifact with no comments keeps
  // the full measure for reading. On a commentable blog the column stays even while it is
  // empty, so the first selection opens a composer beside the article instead of reflowing
  // the paragraph the operator is reading.
  if (disabled && shown.length === 0) {
    return <MarkdownView source={source} variant="article" />;
  }

  return (
    <CommentRail
      article={<MarkdownView source={source} variant="article" />}
      comments={cards}
      composer={composer}
      activeId={activeId}
      onActivate={setActiveId}
      selectable={!disabled && !sending}
      onSelect={onCapture}
      onAnchorsChange={onAnchors}
      railLabel="Comments on this article"
    />
  );
}

/** The in-progress comment, as an ordinary card at its own passage. */
function Composer({
  passage,
  instruction,
  sending,
  full,
  error,
  onChange,
  onCancel,
  onSubmit,
}: {
  passage: string;
  instruction: string;
  sending: boolean;
  /** Three applies are already live, so the engine would refuse this one. */
  full: boolean;
  error: string | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div>
      <Quote text={passage} />
      <Textarea
        autoFocus
        value={instruction}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={3}
        placeholder="What should change in this selection?"
        aria-label="Describe the change for the selected text"
        className="mt-2 text-sm"
        disabled={sending || full}
      />
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        {full
          ? "Three changes are already in flight. Wait for one to land before filing another."
          : "Claude edits only the selected passage, then marks this change resolved."}
      </p>
      {error !== null ? <p className="mt-1.5 text-xs wrap-anywhere text-fail">{error}</p> : null}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel} disabled={sending}>
          Cancel
        </Button>
        <Button size="xs" onClick={onSubmit} disabled={sending || full || instruction.trim() === ""}>
          {sending ? (
            <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
          ) : (
            <Sparkles data-icon="inline-start" aria-hidden />
          )}
          Make changes with Claude
        </Button>
      </div>
    </div>
  );
}

/**
 * One comment's whole thread, in the rail beside its passage: who asked, what they asked
 * for, what the engine did about it, every reply since, and the three doors out.
 *
 * RESOLVE AND REPLY ARE DIFFERENT ACTS and the card offers both, which is the point. Resolve
 * spends a Claude session on the request. Reply says "we cut that line, it was a duplicate"
 * and leaves the request exactly where it was, so an operator can answer a client without
 * either deciding the request on their behalf or making it vanish from the client's rail.
 */
function CommentCard({
  comment,
  unanchored,
  capped,
  onDismiss,
  onResolve,
  onReply,
}: {
  comment: BlogComment;
  /** The passage is no longer in the article, so this card has no highlight to point at. */
  unanchored: boolean;
  /** Three applies are already live, so Resolve would be refused. */
  capped: boolean;
  onDismiss: (comment: BlogComment) => void;
  onResolve: (comment: BlogComment) => void;
  onReply: (comment: BlogComment, body: string) => Promise<void>;
}) {
  // Open and failed both wait on the same act: point Claude at the passage. On a failed
  // comment the button is the retry, whichever side filed it.
  const resolvable = comment.state === "open" || comment.state === "failed";
  // Teammates each run their own engine against one shared record, so this browser can be
  // talking to a build one pull behind, which serves a comment with no replies key at all.
  // Reading .length off that takes the whole stage page down over a field nobody has used
  // yet, which is the sort of white screen that gets blamed on the record.
  const replies = comment.replies ?? [];

  return (
    <div>
      <div className="flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <StateIcon state={comment.state} />
          <AuthorChip author={comment.author} />
        </div>
        {comment.state !== "applying" ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="-mt-0.5 -mr-1"
            aria-label="Dismiss this change"
            onClick={() => onDismiss(comment)}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </div>

      <div className="mt-1.5">
        <Quote text={comment.selected_text} />
      </div>
      <p className="mt-1.5 text-sm text-foreground">{comment.instruction}</p>

      {comment.state === "failed" && comment.error ? (
        // The engine's own sentence: it names why nothing was changed.
        <p className="mt-1 text-xs wrap-anywhere text-fail">{comment.error}</p>
      ) : null}

      {unanchored ? (
        // Never dropped, only unpinned. The passage was edited or removed after this was
        // filed, so the highlight has nothing to sit on, and hiding the card would hide a
        // request nobody has answered yet.
        <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Link2Off className="mt-0.5 size-3 shrink-0" aria-hidden />
          This passage is not in the article any more, so this comment has no highlight. An
          edit rewrote or removed the text it names.
        </p>
      ) : null}

      <p className="machine mt-1.5 text-xs text-muted-foreground">
        <Since comment={comment} />
      </p>

      {replies.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2 border-l border-border pl-2.5">
          {replies.map((reply) => (
            <li key={reply.id}>
              <div className="flex items-center gap-1.5">
                <AuthorChip author={reply.author} />
                <span className="machine text-xs text-muted-foreground">
                  {formatRelative(reply.created)}
                </span>
              </div>
              <p className="mt-0.5 text-sm wrap-anywhere text-foreground">{reply.body}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {resolvable ? (
          <Button
            size="xs"
            variant="outline"
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
        <ReplyBox comment={comment} onReply={onReply} />
      </div>
    </div>
  );
}

/**
 * The reply door, closed until it is asked for.
 *
 * A textarea open on every card in a 20rem column would push the next comment half a screen
 * down for a box almost nobody is typing in, so the button is the resting state and the box
 * is what a click buys. State lives here rather than in the rail's parent: one card's
 * half-written reply is nothing any other card or the article has to know about.
 */
function ReplyBox({
  comment,
  onReply,
}: {
  comment: BlogComment;
  onReply: (comment: BlogComment, body: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function send() {
    if (body.trim() === "") {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onReply(comment, body.trim());
      setOpen(false);
      setBody("");
    } catch (cause) {
      // The engine's refusal, in the box that caused it. A toast would put the reason
      // somewhere other than the words it is about.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        <Reply data-icon="inline-start" aria-hidden />
        Reply
      </Button>
    );
  }

  return (
    <div className="w-full">
      <Textarea
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        rows={2}
        placeholder="Reply to this comment"
        aria-label="Reply to this comment"
        className="text-sm"
        disabled={sending}
      />
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        The client reads this in their own rail. Replying leaves the change request open.
      </p>
      {error !== null ? <p className="mt-1 text-xs wrap-anywhere text-fail">{error}</p> : null}
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <Button
          size="xs"
          variant="ghost"
          disabled={sending}
          onClick={() => {
            setOpen(false);
            setBody("");
            setError(null);
          }}
        >
          Cancel
        </Button>
        <Button size="xs" disabled={sending || body.trim() === ""} onClick={() => void send()}>
          {sending ? (
            <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
          ) : null}
          Send reply
        </Button>
      </div>
    </div>
  );
}

/** The passage the card is about, quoted the way the card's own comment quotes it. */
function Quote({ text }: { text: string }) {
  return (
    <p className="border-l-2 border-review/50 pl-2 text-xs text-muted-foreground">
      <span className="line-clamp-2">&ldquo;{text}&rdquo;</span>
    </p>
  );
}

function StateIcon({ state }: { state: BlogComment["state"] }) {
  return (
    <span className="shrink-0">
      {state === "applying" ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
      ) : state === "resolved" ? (
        <Check className="size-3.5 text-ship" aria-hidden />
      ) : state === "open" ? (
        // The review tone, not the fail one: an open suggestion is the client asking, and
        // the hollow circle says nothing has run yet.
        <CircleDashed className="size-3.5 text-review" aria-hidden />
      ) : (
        <TriangleAlert className="size-3.5 text-fail" aria-hidden />
      )}
      <span className="sr-only">{state}</span>
    </span>
  );
}

/**
 * How long this comment has been where it is.
 *
 * THE APPLYING CLOCK IS applying_since, NEVER created. A comment filed an hour ago and
 * retried a minute ago is one minute into its apply, and reading created there tells the
 * operator an apply has hung when nothing has, which is exactly the sort of false alarm that
 * gets a real one ignored. The engine ages its own stranded-apply sweep on the same field,
 * so the two agree about what "since" means. The fallback covers a record written before the
 * column existed.
 */
function Since({ comment }: { comment: BlogComment }) {
  if (comment.state === "applying") {
    return <>applying since {formatRelative(comment.applying_since ?? comment.created)}</>;
  }
  if (comment.state === "open") {
    // The words carry the obligation: an open client suggestion sits with the admin, and
    // "open" alone would read as somebody else's queue.
    return comment.author === "client" ? (
      <>waiting on you since {formatRelative(comment.created)}</>
    ) : (
      <>open since {formatRelative(comment.created)}</>
    );
  }
  return (
    <>
      {comment.state} {formatRelative(comment.finished ?? comment.created)}
    </>
  );
}

/**
 * Who filed the comment, said in words first: "client" is a suggestion from the portal and
 * "you" is this side's own, and the difference decides whether the card is owed an act or
 * merely reports one.
 *
 * The client's chip also carries the review tone, which is the same amber the highlights and
 * the waiting-on-you banner use, so a rail of a dozen cards says at a glance which of them
 * came from outside. The word is what it MEANS; the colour only makes it findable, which is
 * why the word never goes away.
 */
function AuthorChip({ author }: { author: BlogComment["author"] }) {
  const client = author === "client";
  return (
    <span
      className={cn(
        "machine inline-flex h-4 shrink-0 items-center rounded border px-1 text-[0.625rem] leading-none",
        client
          ? "border-review/30 bg-review-bg text-review"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {client ? "client" : "you"}
    </span>
  );
}

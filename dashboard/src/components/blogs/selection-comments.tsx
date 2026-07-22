"use client";

import * as React from "react";
import {
  BookmarkPlus,
  Check,
  CircleDashed,
  Laptop,
  Link2Off,
  Loader2,
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
  canResolve,
  canAddToInstructions,
  deploymentLocked,
  remaining,
  onSubmit,
  onDismiss,
  onResolve,
  onAddToInstructions,
}: {
  source: string;
  /** Every comment the engine holds for this blog, dismissed ones included: the filtering
   *  is a decision this file makes, not one the caller should have to remember. */
  comments: BlogComment[];
  disabled: boolean;
  /** Whether Resolve may be offered at all. A SEPARATE QUESTION FROM `disabled`, and the
   *  two are not degrees of the same permission: `disabled` asks whether this article takes
   *  comments, this asks whether anything exists to spend a Claude session on one. Filing and
   *  dismissing are database writes the hosted build performs for real, while resolving is an
   *  Agent SDK session that only the local engine can run, so Resolve is the single act that
   *  has to go when the article is otherwise fully commentable. */
  canResolve: boolean;
  /** Whether "Add to brand instructions" may run. The DEPLOYMENT axis alone: the act reframes
   *  the comment with a Claude call and writes the BRAND record, not this article, so the
   *  article's state never gates it, and it stays available on a resolved comment. */
  canAddToInstructions: boolean;
  /** Whether the read-only rail is read-only because of the DEPLOYMENT rather than the article's
   *  state. It selects which sentence a card owed an act prints, and picking the wrong one told
   *  hosted operators the article was closed when it was open. */
  deploymentLocked: boolean;
  /** How many more changes may be filed right now (the 3-in-flight cap minus in flight). */
  remaining: number;
  onSubmit: (draft: SelectionDraft) => Promise<void>;
  onDismiss: (comment: BlogComment) => void;
  /** Starts the Claude apply for one open or failed comment. The engine owns the cap. */
  onResolve: (comment: BlogComment) => void;
  /** Reframes this comment as a standing instruction and appends it to the brand's custom
   *  instructions. Rejects with the engine's own sentence for the card to render inline. */
  onAddToInstructions: (comment: BlogComment) => Promise<void>;
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
            canResolve={canResolve}
            canAddToInstructions={canAddToInstructions}
            deploymentLocked={deploymentLocked}
            readOnly={disabled}
            onDismiss={onDismiss}
            onResolve={onResolve}
            onAddToInstructions={onAddToInstructions}
          />
        ),
      })),
    [
      shown,
      lost,
      full,
      canResolve,
      canAddToInstructions,
      deploymentLocked,
      disabled,
      onDismiss,
      onResolve,
      onAddToInstructions,
    ],
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
          Resolve with Claude
        </Button>
      </div>
    </div>
  );
}

/**
 * One comment's card, in the rail beside its passage: who asked, what they asked for, what
 * the engine did about it, and the doors out.
 *
 * TWO ACTS, NO REPLY. Resolve spends a Claude session on the request; Dismiss declines it.
 * Comments are not threads: the client files a note and reads its state, and that is the
 * whole conversation. "Add to brand instructions" is the third door and it is NOT an act on
 * this article: it reframes the note as a standing instruction for every future blog and
 * appends it to the brand record, which is why it survives both a resolved comment and a
 * read-only article.
 *
 * A RESOLVED CARD KEEPS ITS PLACE AND ITS BUTTON. The green tick says what happened, the
 * Resolve button stays visible and disabled so the card still reads as the same card, the
 * anchor keeps pointing at the passage (hover still highlights it), and Add to brand
 * instructions stays live: a note worth generalising is worth generalising after the fix.
 */
function CommentCard({
  comment,
  unanchored,
  capped,
  canResolve,
  canAddToInstructions,
  deploymentLocked,
  readOnly,
  onDismiss,
  onResolve,
  onAddToInstructions,
}: {
  comment: BlogComment;
  /** The passage is no longer in the article, so this card has no highlight to point at. */
  unanchored: boolean;
  /** Three applies are already live, so Resolve would be refused. */
  capped: boolean;
  /**
   * The article takes no CHANGES right now, so this card carries no change doors.
   *
   * A DIFFERENT QUESTION FROM `canResolve`, which asks whether an engine exists to run one act.
   * This asks whether the ARTICLE is open, and when it is not, dismissing goes with it: the
   * record says the client accepted these exact bytes, and an admin waving a suggestion away
   * afterwards edits a conversation that is closed.
   */
  readOnly: boolean;
  /** An engine is behind this page, so a Claude session can actually run. False replaces the
   *  button with the reason: a card owed an act, offering neither the act nor an explanation
   *  for its absence, reads as a broken card rather than a deliberate one. */
  canResolve: boolean;
  /** The engine axis for Add to brand instructions: the reframe is a Claude call, so the
   *  hosted build hides the button exactly as it hides Resolve. */
  canAddToInstructions: boolean;
  /** The read-only above is the DEPLOYMENT's doing rather than the article's state. */
  deploymentLocked: boolean;
  onDismiss: (comment: BlogComment) => void;
  onResolve: (comment: BlogComment) => void;
  onAddToInstructions: (comment: BlogComment) => Promise<void>;
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
        {comment.state !== "applying" && !readOnly ? (
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

      {/* WHY THIS IS ONE BRANCH WITH TWO SENTENCES AND NOT TWO BRANCHES.
          It used to be two, and the second one was unreachable. The card's `readOnly` is the
          page's `!canComment`, and blog-stage.tsx passes canRunClaude to BOTH canComment and
          canResolve, so `resolvable && !canResolve && !readOnly` reduces to `!x && x`. The
          sentence naming where Resolve runs never rendered once. What rendered instead was the
          state sentence below it, which on the hosted build is FALSE: the article is open, the
          state will never reopen anything because nothing about the state is what refused, and
          an operator sent to look at the tag beside the title finds a tag that disagrees.

          So the two cases are told apart by WHY the card is read only rather than by a second
          flag that turns out to be the first one negated. `deploymentLocked` is true exactly
          where the state would have taken the change and the build refuses it, which makes the
          two arms mutually exclusive by construction rather than by a coincidence of props.

          THE HOSTED ARM PROMISES NOTHING IT CANNOT KEEP. Its predecessor offered dismiss, and
          on this build blogs/[topic]/comments/[id]/route.ts is hostedWriteRefused like every
          other admin write. Naming an act that fails is worse than naming none, so it names
          the machine instead. */}
      {readOnly && resolvable ? (
        deploymentLocked ? (
          <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <Laptop className="mt-0.5 size-3 shrink-0" aria-hidden />
            This request is open and this hosted view cannot act on it. Resolving it with Claude
            and dismissing it both run in the Canon app on your own machine.
          </p>
        ) : (
          // A card owed an act, showing neither the act nor a reason for its absence, reads as
          // broken. This says the absence is the article's state rather than a missing button,
          // and it points at the tag that names which state: the header says "With client" or
          // "Approved" and its tooltip says who owes the next act.
          <p className="mt-1.5 flex gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <CircleDashed className="mt-0.5 size-3 shrink-0" aria-hidden />
            This article is not open for changes right now, so this request is read only here. The
            tag beside the title says where the article is and what would reopen it.
          </p>
        )
      ) : null}

      {/* THE DOORS ROW. Resolve renders enabled on an open or failed comment where an engine
          exists and the article is open, and DISABLED (never absent) on a resolved one: the
          green tick above says what happened and the greyed button keeps the card reading as
          the same card. Add to brand instructions rides only the deployment axis, so it
          survives a resolved comment and a read-only article alike. */}
      {(resolvable && canResolve && !readOnly) ||
      comment.state === "resolved" ||
      canAddToInstructions ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {resolvable && canResolve && !readOnly ? (
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
          ) : comment.state === "resolved" ? (
            <Button size="xs" variant="outline" disabled title="This change is already applied.">
              <Sparkles data-icon="inline-start" aria-hidden />
              Resolve with Claude
            </Button>
          ) : null}
          {canAddToInstructions && comment.state !== "applying" ? (
            <AddToInstructions comment={comment} onAdd={onAddToInstructions} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The brand-instructions door: reframe this note as a standing instruction for every future
 * blog and append it to the brand record.
 *
 * The stamp on the comment is the state, so "Added to instructions" survives a reload and
 * every operator sees the same disabled button. The click is a Claude call plus a record
 * write, so the pending state is honest about taking a few seconds.
 */
function AddToInstructions({
  comment,
  onAdd,
}: {
  comment: BlogComment;
  onAdd: (comment: BlogComment) => Promise<void>;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const added = comment.added_to_instructions != null;

  async function add() {
    setPending(true);
    setError(null);
    try {
      await onAdd(comment);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        disabled={added || pending}
        title={
          added
            ? "This comment is already part of the brand instructions."
            : "Rewrite this comment as a standing instruction for all upcoming blogs and add it to the brand instructions."
        }
        onClick={() => void add()}
      >
        {pending ? (
          <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
        ) : added ? (
          <Check data-icon="inline-start" aria-hidden />
        ) : (
          <BookmarkPlus data-icon="inline-start" aria-hidden />
        )}
        {added ? "Added to instructions" : pending ? "Adding…" : "Add to brand instructions"}
      </Button>
      {error !== null ? (
        <p className="w-full text-xs wrap-anywhere text-fail">{error}</p>
      ) : null}
    </>
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

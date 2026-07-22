"use client";

import * as React from "react";
import { Check, Clock, CornerDownRight, Eye, Loader2, Send } from "lucide-react";
import type { Anchor } from "@/components/comments/anchor";
import { CommentRail, type RailComment } from "@/components/comments/rail";
import type { SelectionCapture } from "@/components/comments/selection";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, detailText } from "@/portal/api";
import { formatRelative } from "@/portal/format";
import { MarkdownView } from "@/portal/markdown-view";
import type {
  PortalComment,
  PortalCommentState,
  PortalReply,
  SuggestBody,
} from "@/portal/types";

/**
 * The client's side of the article conversation: the piece beside its passage, every note
 * beside the sentence it is about.
 *
 * THERE IS NO MODE. Selecting text in an article the client can act on always offers a
 * comment, and the Approve button stands alone with nothing beside it offering a state to
 * be in. The old "Suggest changes" / "Done suggesting" pair is gone: a client who selects a
 * sentence has already said what they mean by selecting it, and a toggle only gave them a
 * way to mean it while the app was not listening.
 *
 * WHETHER THERE IS ANYTHING TO SELECT IS THE CALLER'S CALL, and it arrives as `canSuggest`
 * because lib/blog-state.ts decides it from the article's state. This component never infers
 * it: it has the comments and the article, which is not enough to know whether the record
 * would accept a new one, and guessing here is how an approved article came to offer a
 * suggestion box that migration 013 refuses. With `canSuggest` false the article renders
 * unselectable and no composer can open, so the rail becomes a reading view with the
 * conversation still beside it. There is no reply box anywhere: a comment is a note the team
 * resolves or dismisses, not a thread.
 *
 * The mechanics live in @/components/comments: the rail lays the cards out beside their
 * passages, marks the article, links hover both ways, and captures selections on touch as
 * well as mouse. NONE of the words are its. Everything a client reads here is written here,
 * in the portal's voice, because the same rail carries the operator's screen and the two
 * surfaces mean entirely different things by the same rows.
 *
 * WHAT A CLIENT IS NEVER SHOWN, and it is a rule rather than an omission: the record's
 * error text, the machinery that applies a change, and anything the editorial pipeline
 * measures. A suggestion that failed to apply reads exactly like one still being worked on,
 * because a failure inside the team's tooling is the team's to fix and never the client's
 * to read, let alone to chase.
 */

/** One constant id for the in-progress note, so a keystroke never re-marks the article:
 *  the rail re-marks only when an id or a passage changes. */
const COMPOSER_ID = "composer";

/**
 * The record's five states folded to the three things a client is actually told.
 *
 * open, applying and failed are ONE state to a client: the team has it. failed being here
 * is the rule, not a shortcut. An apply that failed is an internal retry, so telling a
 * client about it would hand them a problem they cannot act on and a word they would have
 * to ask about.
 */
function plainState(state: PortalCommentState): {
  label: string;
  icon: typeof Clock;
  tone: string;
} {
  if (state === "resolved") {
    return { label: "Resolved by the team", icon: Check, tone: "text-ship" };
  }
  if (state === "dismissed") {
    return { label: "Reviewed, no change", icon: Eye, tone: "text-muted-foreground" };
  }
  return { label: "With the team", icon: Clock, tone: "text-muted-foreground" };
}

/**
 * What the client is told when a write does not land.
 *
 * The record's own refusals are written FOR a client and travel verbatim: "ten suggestions
 * are already with the team" is exactly the sentence somebody needs to read. Every other
 * failure is transport or plumbing, whose text describes machinery the client has no part
 * in, so it folds to one calm line. Saying nothing at all is not the alternative: a note
 * that silently fails to send is a note somebody types twice and loses twice.
 */
function sendFailure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.isOffline) {
      return "You seem to be offline. Your note is still here, so try again in a moment.";
    }
    if (cause.status === 409 || cause.status === 422 || cause.status === 429) {
      return detailText(cause);
    }
  }
  return "That did not send. Your note is still here, so try again in a moment.";
}

function Passage({ text }: { text: string }) {
  return (
    <p className="border-l-2 border-review/50 pl-2 text-xs text-muted-foreground">
      <span className="line-clamp-2">{text}</span>
    </p>
  );
}

/** Said once, in one place, for a card whose passage the article no longer contains. The
 *  card stays: a note nobody has answered must never vanish because the sentence it was
 *  about was rewritten. */
function Unanchored() {
  return (
    <p className="mt-1.5 text-xs text-muted-foreground italic">
      This passage is not in the article any more.
    </p>
  );
}

// ---------------------------------------------------------------------------
// The composer: an in-progress note, as an ordinary card at its own passage
// ---------------------------------------------------------------------------

function Composer({
  passage,
  text,
  onText,
  onCancel,
  onSend,
  sending,
  error,
  anchored,
}: {
  passage: string;
  text: string;
  onText: (value: string) => void;
  onCancel: () => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  anchored: boolean;
}) {
  return (
    <div>
      <Passage text={passage} />
      {anchored ? null : <Unanchored />}
      <Textarea
        autoFocus
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSend();
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
      {error !== null ? (
        <p role="alert" className="mt-1.5 text-xs wrap-anywhere text-fail">
          {error}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={sending}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSend} disabled={sending || text.trim() === ""}>
          {sending ? (
            <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
          ) : (
            <Send data-icon="inline-start" aria-hidden />
          )}
          Send to the team
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A filed suggestion, its state, its thread, and the way back into it
// ---------------------------------------------------------------------------

function ReplyLine({ reply }: { reply: PortalReply }) {
  return (
    <li className="flex gap-1.5">
      <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">
          {reply.author === "you" ? "You" : "Our team"}
          <span className="ml-1.5 font-normal text-muted-foreground">
            {formatRelative(reply.created)}
          </span>
        </p>
        <p className="text-sm leading-snug text-pretty whitespace-pre-wrap">{reply.body}</p>
      </div>
    </li>
  );
}

/**
 * One suggestion's card: what the client asked, where it stands, and what has been said.
 *
 * THERE IS NO REPLY BOX. Comments are not threads: the client files a note, the team resolves
 * it with Claude or dismisses it, and the card's state line is the whole answer. Replies that
 * were filed before the feature was removed still render below, as history.
 */
function ThreadCard({
  comment,
  anchored,
}: {
  comment: PortalComment;
  anchored: boolean;
}) {
  const state = plainState(comment.state);
  const StateIcon = state.icon;

  return (
    <div>
      <Passage text={comment.selected_text} />
      {anchored ? null : <Unanchored />}
      <p className="mt-1.5 text-sm leading-snug text-pretty whitespace-pre-wrap">
        {comment.instruction}
      </p>
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <StateIcon className={`size-3.5 shrink-0 ${state.tone}`} aria-hidden />
        {state.label}
        <span aria-hidden>·</span>
        sent {formatRelative(comment.created)}
      </p>

      {comment.replies.length > 0 ? (
        <ul className="mt-2.5 space-y-2 border-t pt-2.5">
          {comment.replies.map((reply) => (
            <ReplyLine key={reply.id} reply={reply} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The article and its rail
// ---------------------------------------------------------------------------

export function CommentedArticle({
  source,
  comments,
  onSuggest,
  canSuggest,
}: {
  source: string;
  /** The client's own suggestions with their threads, oldest first. */
  comments: PortalComment[];
  onSuggest: (draft: SuggestBody) => Promise<void>;
  /** clientCan(state, "suggest"): whether selecting a passage may open a composer at all. */
  canSuggest: boolean;
}) {
  const [pending, setPending] = React.useState<{ capture: SelectionCapture; text: string } | null>(
    null,
  );
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [lost, setLost] = React.useState<string[]>([]);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const close = React.useCallback(() => {
    setPending(null);
    setError(null);
    // The composer's textarea autofocuses, which makes the composer the active card. Left
    // set, that id outlives the card it names and holds the rail's default anchor on a card
    // nobody can see, so every other card keeps reflowing around a ghost.
    setActiveId((current) => (current === COMPOSER_ID ? null : current));
  }, []);

  /**
   * A settled selection inside the article, or null when the reader clears one.
   *
   * TYPED WORDS WIN OVER A NEW SELECTION. A client who has started writing and then
   * double-clicks a word to re-read it would otherwise lose the note, which is a worse
   * outcome than the note staying attached to the passage they opened it for. The passage
   * is quoted in the card and highlighted in the article the whole time, so there is
   * nothing ambiguous about which sentence an in-progress note belongs to, and Cancel is
   * always one press away.
   */
  const onSelect = React.useCallback((capture: SelectionCapture | null) => {
    setPending((current) => {
      if (current !== null && current.text.trim() !== "") {
        return current;
      }
      return capture === null ? null : { capture, text: "" };
    });
  }, []);

  // Which cards have no passage left in the article. Compared before storing, because the
  // rail reports the whole anchor set on every measurement and a fresh array each time
  // would re-render every card for a number that did not change.
  const onAnchorsChange = React.useCallback((anchors: Anchor[]) => {
    setLost((prev) => {
      const next = anchors.filter((anchor) => !anchor.found).map((anchor) => anchor.id);
      const same = prev.length === next.length && next.every((id, i) => prev[i] === id);
      return same ? prev : next;
    });
  }, []);

  // Escape closes the in-progress note, the one keyboard exit a card without a Cancel in
  // reach still needs.
  React.useEffect(() => {
    if (pending === null) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending, close]);

  async function submit() {
    if (pending === null || pending.text.trim() === "") {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSuggest({
        selected_text: pending.capture.text,
        context_before: pending.capture.before,
        context_after: pending.capture.after,
        instruction: pending.text.trim(),
      });
      close();
      // Dropping the range stops the passage reading as still selected under its own new
      // highlight. It reports no ranges rather than an empty one, so it cannot come back
      // through the capture as a fresh note.
      window.getSelection()?.removeAllRanges();
    } catch (cause) {
      setError(sendFailure(cause));
    } finally {
      setSending(false);
    }
  }

  const cards: RailComment[] = comments.map((comment) => ({
    id: comment.id,
    selected_text: comment.selected_text,
    body: (
      <ThreadCard comment={comment} anchored={!lost.includes(comment.id)} />
    ),
  }));

  // A composer can only exist where a suggestion is permitted. The guard is here rather than on
  // the selection handler alone so that a note left half typed when the article is approved in
  // another tab disappears with the permission, instead of sitting there offering to send.
  const composer: RailComment | null =
    pending === null || !canSuggest
      ? null
      : {
          id: COMPOSER_ID,
          selected_text: pending.capture.text,
          body: (
            <Composer
              passage={pending.capture.text}
              text={pending.text}
              onText={(value) =>
                setPending((current) => (current === null ? current : { ...current, text: value }))
              }
              onCancel={close}
              onSend={() => void submit()}
              sending={sending}
              error={error}
              anchored={!lost.includes(COMPOSER_ID)}
            />
          ),
        };

  // No rail where there is nothing to put in one and nothing can be filed: the article keeps
  // the full measure instead of holding an empty 20rem margin. This is the approved and
  // published reading view (the caller passes no comments there), and the same guard the
  // admin stage applies.
  if (cards.length === 0 && !canSuggest) {
    return (
      <article className="rounded-xl bg-card p-6 ring-1 ring-foreground/10 sm:p-10">
        <MarkdownView source={source} />
      </article>
    );
  }

  return (
    <CommentRail
      article={
        <article className="rounded-xl bg-card p-6 ring-1 ring-foreground/10 sm:p-10">
          <MarkdownView source={source} />
        </article>
      }
      comments={cards}
      composer={composer}
      activeId={activeId}
      onActivate={setActiveId}
      onSelect={onSelect}
      // Not selectable once suggesting is refused: the rail stops capturing selections at all,
      // so the article reads as ordinary prose rather than as a surface that swallows a
      // highlight and offers nothing back.
      selectable={canSuggest}
      onAnchorsChange={onAnchorsChange}
      railLabel="Your notes on this article"
    />
  );
}

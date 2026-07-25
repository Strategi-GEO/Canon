import { cn } from "@/lib/utils";
import type { BlogStatus } from "@/types";

type Style = { className: string; label: string; title?: string };

const STYLES: Record<BlogStatus, Style> = {
  done: { className: "bg-ship-bg text-ship border-ship/25", label: "shipped" },
  /**
   * A HUMAN OWES AN ANSWER, and that is the whole of what this word means. It is a workflow state
   * rather than a verdict: a blog held at 96 has a verdict and the verdict is ship, so the label
   * must not read as a judgement on the draft. It says which act is owed instead, because the
   * score is not what is missing here and telling an operator their 96 "needs review" invites them
   * to go looking for the flaw rather than to answer the question.
   *
   * The review tone, never the fail one. A question is not damage: the evaluator reached the end
   * of what research settles and asked the one source that can settle it.
   */
  needs_review: {
    className: "bg-review-bg text-review border-review/25",
    label: "waiting on you",
    title:
      "This blog has questions waiting for you, and it is held until you answer them whatever it scored. Open it to read them: answering starts one surgical revise of the existing draft.",
  },
  failed: { className: "bg-fail-bg text-fail border-fail/25", label: "failed" },
  running: {
    className: "bg-muted text-muted-foreground border-border",
    label: "running",
  },
  /**
   * NEUTRAL, and never the fail tint. A stopped blog is not a blog that went wrong: the operator
   * pressed Stop, so the engine did no more work on it and made no judgement about the draft.
   * Painting it red would report a person's own decision back to them as damage, and it would
   * put a red count on a batch that is working exactly as asked.
   *
   * It borrows the muted fill from `running` rather than a colour of its own, because there is
   * no fourth hue here and inventing one would put a new meaning on screen that nothing else in
   * this app teaches. The border carries the difference and the LABEL carries it properly:
   * colour is never the only signal in this table.
   */
  stopped: {
    className: "border-muted-foreground/40 bg-muted text-muted-foreground",
    label: "stopped",
    title:
      "You stopped this brand's session before this blog finished. Nothing was deleted: whatever it had researched or drafted is still on disk, and generating the topic again picks it up.",
  },
  /**
   * Its own state, never borrowed from another.
   *
   * This badge used to fall back to `running`, so a topic the engine could say nothing about
   * was reported as in flight. That is the worst answer this column can give: the one
   * question it exists to answer is "is this still going", and a wrong yes sends an operator
   * away to wait for a blog that already finished, died, or was copied in by hand.
   *
   * Dashed and hollow, so it is distinguishable from running's solid muted fill without
   * leaning on colour, and it borrows neither a terminal colour nor the in-flight one. The
   * label says the same thing the border does, because colour is never the only signal here.
   */
  unknown: {
    className: "border-dashed border-muted-foreground/40 text-muted-foreground",
    label: "unknown",
    title:
      "This topic has a blog.md but no readable status line, so the engine cannot say how it ended.",
  },
};

/**
 * Status colours carry meaning, so they stay off the accent hue in every state.
 *
 * The fallback is `unknown` rather than any real state: a value this app does not recognise
 * IS unknown, and aliasing it onto a state the engine never reported would invent a fact.
 */
export function StatusBadge({ status, className }: { status: BlogStatus; className?: string }) {
  const style = STYLES[status] ?? STYLES.unknown;
  return (
    <span
      title={style.title}
      className={cn(
        "machine inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[0.6875rem] leading-none",
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}

/** A score is a machine value, and 95 is the ship line, so only a shipped score gets the accent. */
export function ScoreTag({ score, shipped }: { score: number | null; shipped: boolean }) {
  if (score === null) {
    return <span className="machine text-xs text-muted-foreground">no score</span>;
  }
  return (
    <span
      className={cn(
        "machine text-xs font-medium",
        shipped ? "text-primary" : "text-muted-foreground",
      )}
    >
      {score}/100
    </span>
  );
}

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  adminCommentsTag,
  adminTag,
  clientCommentsTag,
  clientTag,
  type BlogState,
  type StateTone,
} from "@/lib/blog-state";

/**
 * The tag that says where a blog is.
 *
 * ONE COMPONENT, TWO AUDIENCES, and the `audience` prop picks the vocabulary rather than the
 * caller assembling its own words. An admin sees "Internal review" and a client sees "In
 * progress" for the same record at the same instant, which is the point: they are different
 * sentences about ONE state, not two states that could drift apart.
 *
 * It replaces StatusBadge everywhere a whole blog is being described. StatusBadge remains for
 * the RUN status alone, which is a narrower fact: it answers "how did the loop end", while this
 * answers "where is this article and who owes the next act". The run status is an input to this,
 * not a synonym for it, and the difference is exactly what the old badge could not express: a
 * blog that is `done` might be with the team, with the client, approved or live, and every one
 * of those wants a different word.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. Every tone below pairs with a label that carries the same
 * meaning in words, so the tag reads correctly in greyscale and to anyone who cannot separate
 * the hues. The tooltip then names WHO OWES WHAT, which is the question a person scanning a list
 * is actually asking.
 */

const TONES: Record<StateTone, string> = {
  // Work in flight. The muted fill this app already uses for `running`, so an in-flight article
  // reads the same wherever it appears.
  busy: "bg-muted text-muted-foreground border-border",
  // A person owes an act. The review tone, deliberately NOT the fail tone: an article waiting on
  // someone is not an article that went wrong, and painting it red sends whoever sees it looking
  // for damage that is not there.
  owed: "bg-review-bg text-review border-review/25",
  // Waiting on someone else. Hollow rather than filled, because a filled tag reads as a claim on
  // the reader's attention and this state is precisely the one that wants none of it.
  waiting: "border-muted-foreground/40 text-muted-foreground",
  ship: "bg-ship-bg text-ship border-ship/25",
  trouble: "bg-fail-bg text-fail border-fail/25",
};

export function BlogStateTag({
  state,
  audience,
  commentsPending,
  className,
}: {
  state: BlogState;
  /** Which vocabulary to speak. Never inferred: the same component renders on both surfaces. */
  audience: "admin" | "client";
  /**
   * changes_requested only: how many of the client's comments are still unaddressed (open,
   * applying or failed). BOTH audiences split on it, each in its own vocabulary: the client
   * between "Pending comments" and "Comments resolved", the admin between "Changes requested"
   * and "With client". The labels live in blog-state.ts with every other label (labels never
   * leave that file); this prop only carries the one fact the state itself cannot. Omitting
   * it falls back to the plain state tag.
   */
  commentsPending?: number | null;
  className?: string;
}) {
  const pending =
    state === "changes_requested" && typeof commentsPending === "number" ? commentsPending : null;
  const tag =
    audience === "admin"
      ? pending !== null
        ? adminCommentsTag(pending)
        : adminTag(state)
      : pending !== null
        ? clientCommentsTag(pending)
        : clientTag(state);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* cursor-default because this is a label rather than a control: a pointer cursor would
            promise a click that does nothing. */}
        <span
          className={cn(
            "inline-flex cursor-default items-center rounded-full border px-2 py-0.5",
            "text-[0.6875rem] font-medium whitespace-nowrap",
            TONES[tag.tone],
            className,
          )}
        >
          {tag.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="machine">{tag.detail}</span>
      </TooltipContent>
    </Tooltip>
  );
}

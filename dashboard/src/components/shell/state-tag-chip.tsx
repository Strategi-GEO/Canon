import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { StateTag, StateTone } from "@/lib/blog-state";

/**
 * The ONE tag chip: a coloured pill with the label and a tooltip naming who owes what. It takes a
 * pre-resolved {label, tone, detail} and nothing else, so every tag surface (blog state, channel
 * state, and any future one) renders identically and the tone-to-class map lives in exactly one
 * place. The vocabulary lives with each state machine (blog-state.ts, channel-state.ts); this owns
 * only the paint.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL: every tone pairs with a label that carries the same meaning in
 * words, so the chip reads in greyscale. No "score" word crosses this file, so it is safe in the
 * client bundle (tests/portal_check.py).
 */
const TONES: Record<StateTone, string> = {
  busy: "bg-muted text-muted-foreground border-border",
  owed: "bg-review-bg text-review border-review/25",
  waiting: "border-muted-foreground/40 text-muted-foreground",
  ship: "bg-ship-bg text-ship border-ship/25",
  trouble: "bg-fail-bg text-fail border-fail/25",
};

export function StateTagChip({ tag, className }: { tag: StateTag; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* cursor-default because this is a label, not a control: a pointer cursor would promise a
            click that does nothing. */}
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

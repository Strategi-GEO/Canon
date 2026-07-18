"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  clearHighlights,
  commentIdAt,
  highlightComments,
  measureAnchors,
  setActiveMark,
  type Anchor,
} from "@/components/comments/anchor";
import { useLatest, useSelectionCapture, type SelectionCapture } from "@/components/comments/selection";

/**
 * The comment rail: an article beside a column of cards, each card level with the passage it
 * annotates.
 *
 * BOTH SIDES OF THE REVIEW USE THIS ONE COMPONENT, so it carries no words of its own. Every
 * card is a `body` the caller renders, the rail's accessible name is a prop, and there is not
 * a single string in this file that reaches a screen. That is deliberate: the two callers
 * annotate the same article and mean entirely different things by it, and one shared
 * component with a shared vocabulary would leak one side's language onto the other's screen.
 * Keep it that way. Nothing that names an action, a state, or a person belongs here.
 *
 * The layout is the part worth explaining. Cards want to sit at their passage's exact top,
 * which two cards on neighbouring sentences cannot both have, so a card that would overlap
 * the one above it is pushed down. The CHOSEN card is the exception: it always wins its own
 * anchor and everything else reflows around it, upwards above it and downwards below it,
 * which is what makes clicking a card feel like it snaps to its sentence. HOVER NEVER MOVES
 * ANYTHING: reading an article sweeps the pointer across the text, and a rail that reflowed
 * on every crossed highlight rearranged itself continuously under a reader who had asked for
 * nothing. Pointing raises the ring and lights the passage; a click is what moves the rail.
 * Below the lg
 * breakpoint the whole arrangement collapses to a plain list under the article, because a
 * phone has no margin to put a rail in and a 20rem column beside a 20rem article is not a
 * reading experience.
 */

/** About 20rem of rail, and the gap that keeps two stacked cards from touching. */
const RAIL_WIDTH = "lg:w-80";
const CARD_GAP = 12;
/** Cards whose passage is gone have no anchor to sort by, so they sit under the anchored run
 *  with a wider gap: they are a different kind of thing and should not read as the next
 *  paragraph's comment. */
const LOOSE_GAP = 28;
/** Used for a card that has not been measured yet, which is only ever the first frame. */
const ASSUMED_CARD_HEIGHT = 96;

/**
 * useLayoutEffect warns when React renders on the server, and this component does server
 * render: it is a client component, which Next still renders once on the server. The effects
 * below all read layout before paint, so they cannot become plain effects, and the swap is
 * the standard way to keep both true.
 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export type RailComment = {
  id: string;
  /** The passage this card annotates, as rendered text. Field named for the record's column
   *  so neither caller has to rename anything on the way in. */
  selected_text: string;
  /** Everything the card shows. The caller's own copy, its own actions, its own voice. */
  body: React.ReactNode;
};

function sameAnchors(a: Anchor[], b: Anchor[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((row, i) => {
    const other = b[i];
    return row.id === other.id && row.found === other.found && Math.abs(row.top - other.top) < 0.5;
  });
}

function sameHeights(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) {
    return false;
  }
  return keys.every((key) => Math.abs((a[key] ?? -1) - b[key]) < 0.5);
}

/**
 * Where every card sits, and how tall the column has to be to hold them.
 *
 * Pure, and separated from the component for exactly that reason: this is the piece with the
 * arithmetic in it, and it is the piece a layout bug lives in.
 */
function placeCards(
  cards: RailComment[],
  anchors: Map<string, Anchor>,
  heights: Record<string, number>,
  /** The card that keeps its exact anchor while the others reflow around it. A CHOSEN card
   *  only: passing a hovered one here rearranges the rail under a reader's pointer. */
  pivotId: string | null,
): { tops: Map<string, number>; height: number } {
  const heightOf = (id: string) => heights[id] ?? ASSUMED_CARD_HEIGHT;

  const anchored: { id: string; top: number }[] = [];
  const loose: string[] = [];
  for (const card of cards) {
    const anchor = anchors.get(card.id);
    if (anchor !== undefined && anchor.found) {
      anchored.push({ id: card.id, top: anchor.top });
    } else {
      loose.push(card.id);
    }
  }
  // Stable by specification since ES2019, so two cards on the same passage keep the order
  // the caller handed them, which is the order they were filed in.
  anchored.sort((a, b) => a.top - b.top);

  const tops = anchored.map((row) => row.top);
  const activeIndex = anchored.findIndex((row) => row.id === pivotId);
  const pivot = activeIndex >= 0 ? activeIndex : 0;

  // Above the pivot, walking up: each card ends where the one below it begins, minus the
  // gap. This is what lets the chosen card keep its own anchor instead of being shoved down
  // by whatever happens to sit above it.
  for (let i = pivot - 1; i >= 0; i -= 1) {
    tops[i] = Math.min(anchored[i].top, tops[i + 1] - CARD_GAP - heightOf(anchored[i].id));
  }
  // Below the pivot, walking down: the ordinary push.
  for (let i = pivot + 1; i < anchored.length; i += 1) {
    tops[i] = Math.max(anchored[i].top, tops[i - 1] + heightOf(anchored[i - 1].id) + CARD_GAP);
  }

  // Enough cards above the chosen one and the upward pass runs off the top of the column,
  // where they cannot be read at all. THE WHOLE RUN SLIDES DOWN by the overshoot rather than
  // each card being clamped to zero independently: clamping preserved the pivot's position
  // and paid for it by stacking the cards above it ON TOP OF EACH OTHER, which is precisely
  // the overlap this function exists to prevent. Sliding keeps every gap intact and spends
  // the pivot's exact alignment instead, which is the honest trade: something has to give,
  // and a card that lost its alignment still reads, while two cards in the same place do not.
  if (anchored.length > 0 && tops[0] < 0) {
    const slide = -tops[0];
    for (let i = 0; i < tops.length; i += 1) {
      tops[i] += slide;
    }
  }

  const out = new Map<string, number>();
  let bottom = 0;
  anchored.forEach((row, i) => {
    out.set(row.id, tops[i]);
    bottom = Math.max(bottom, tops[i] + heightOf(row.id));
  });
  for (const id of loose) {
    const top = bottom === 0 ? 0 : bottom + LOOSE_GAP;
    out.set(id, top);
    bottom = top + heightOf(id);
  }
  return { tops: out, height: bottom };
}

export function CommentRail({
  article,
  comments,
  activeId,
  onActivate,
  composer = null,
  onSelect,
  selectable = false,
  onAnchorsChange,
  railLabel,
  className,
}: {
  /** The rendered article. Must be content React does not update node by node, which in this
   *  app means the markdown view: the rail wraps runs of its text in marks, and React would
   *  lose track of children it thinks it owns. */
  article: React.ReactNode;
  comments: RailComment[];
  /** The card that wins its anchor and reads as selected. The caller holds it, because the
   *  caller is what a click on a card usually has to change as well. */
  activeId: string | null;
  /** Fired when a card or a highlighted passage is CLICKED or FOCUSED, and with null when a
   *  click lands on unmarked article text. Hover is handled inside the rail and never
   *  reported: a callback firing on every pointer move would put the caller's state in the
   *  path of a mouse crossing the page. */
  onActivate: (id: string | null) => void;
  /** An in-progress comment, as an ordinary card at its own passage. Passing it here rather
   *  than floating it over the article is what keeps the passage highlighted while somebody
   *  types, because the composer's own passage goes through the same marking pass every
   *  other card's does. */
  composer?: RailComment | null;
  /** Handed every settled selection inside the article, and null when the reader clears one
   *  by clicking the text. */
  onSelect?: (capture: SelectionCapture | null) => void;
  /** Off, selections mean nothing. */
  selectable?: boolean;
  /** Which comments found their passage and which did not. The caller decides what an
   *  unanchored card says, because saying it is the caller's job. */
  onAnchorsChange?: (anchors: Anchor[]) => void;
  /** The accessible name of the rail region. A prop, like every other string here. */
  railLabel: string;
  className?: string;
}) {
  const articleRef = React.useRef<HTMLDivElement>(null);
  const columnRef = React.useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = React.useState<Anchor[]>([]);
  const [heights, setHeights] = React.useState<Record<string, number>>({});
  const [hovered, setHovered] = React.useState<string | null>(null);

  const cards = React.useMemo(
    () => (composer === null ? comments : [...comments, composer]),
    [comments, composer],
  );

  // The anchoring targets, rebuilt ONLY when an id or a passage actually changes. A caller
  // maps its own state into `comments` on every render, so depending on that array would
  // re-mark the whole article on every keystroke in the composer, and a re-mark rebuilds
  // every mark in the document. The serialized key IS the identity here, and deriving the
  // targets back out of it is what stops the dependency from quietly widening to the array
  // again the next time somebody edits this effect.
  const targetKey = JSON.stringify(cards.map((card) => [card.id, card.selected_text]));
  const targets = React.useMemo(
    () =>
      (JSON.parse(targetKey) as [string, string][]).map(([id, passage]) => ({
        id,
        selected_text: passage,
      })),
    [targetKey],
  );

  // Hover is transient and local; the active card is sticky and the caller's. Blending them
  // here gives both behaviours from one prop pair: pointing at a card raises it, and letting
  // go returns the rail to whatever was actually chosen. A composer with nothing else chosen
  // wins by default, because the passage somebody is writing about is the one they are
  // looking at.
  const live = hovered ?? activeId ?? composer?.id ?? null;

  // WHAT THE LAYOUT PIVOTS ON, and it deliberately excludes hover.
  //
  // Feeding `live` to placeCards made every card in the rail move whenever the pointer
  // crossed a highlight, because the pivot decides which card keeps its exact anchor and
  // every other card reflows around it. Reading an article means sweeping the pointer over
  // the text, so the rail rearranged itself continuously under a reader who had asked for
  // nothing. A document tool moves its margin on a CHOICE (a click, a focus, opening a
  // composer) and never on a glance. Hover keeps the highlight and the raised ring, which
  // is the whole of what pointing at something should promise.
  const pivotId = activeId ?? composer?.id ?? null;

  useIsomorphicLayoutEffect(() => {
    const container = articleRef.current;
    if (container === null) {
      return;
    }
    const ids = targets.map((target) => target.id);
    let frame = 0;

    // The article is replaced under us more often than the comments change: a poll lands a
    // newer body, an edit is applied, a tab switches back. Without this the marks vanish with
    // the old innerHTML and never come back until a comment happens to change. Disconnecting
    // around our own writes is what keeps that from being a loop, and disconnect() drops the
    // queued records so reconnecting cannot replay them.
    const content = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(mark);
    });
    // Reflow moves passages without changing a single character: a window resize, a font
    // landing, the editor opening beside it. Measuring is read-only, so it is safe to do from
    // the observer watching the thing being measured.
    const size = new ResizeObserver(() => {
      setAnchors((prev) => {
        const next = measureAnchors(container, ids);
        return sameAnchors(prev, next) ? prev : next;
      });
    });

    function mark() {
      const element = articleRef.current;
      if (element === null) {
        return;
      }
      content.disconnect();
      const next = highlightComments(element, targets);
      setAnchors((prev) => (sameAnchors(prev, next) ? prev : next));
      content.observe(element, { childList: true, subtree: true, characterData: true });
    }

    mark();
    size.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      content.disconnect();
      size.disconnect();
      clearHighlights(container);
    };
  }, [targets]);

  // One attribute write per hover, never a re-mark. Runs after the marking effect in the
  // same commit, so a re-mark that dropped the flag puts it back before anything is painted.
  useIsomorphicLayoutEffect(() => {
    const container = articleRef.current;
    if (container !== null) {
      setActiveMark(container, live);
    }
  }, [live, anchors]);

  const measureCards = React.useCallback(() => {
    const column = columnRef.current;
    if (column === null) {
      return;
    }
    const next: Record<string, number> = {};
    for (const element of Array.from(column.querySelectorAll<HTMLElement>("[data-comment-card]"))) {
      const id = element.getAttribute("data-comment-card");
      if (id !== null) {
        // getBoundingClientRect, not offsetHeight: offsetHeight rounds to whole pixels and
        // always DOWN, so a column of cards accumulates a sub-pixel of overlap each, and the
        // gap between two of them quietly shrinks below what the layout asked for.
        next[id] = element.getBoundingClientRect().height;
      }
    }
    setHeights((prev) => (sameHeights(prev, next) ? prev : next));
  }, []);

  // A card's height decides where the next one starts, and it changes without the card set
  // changing: a textarea grows a line, an error sentence appears. Observing each card is
  // cheaper and steadier than observing the column, whose own height this then sets.
  useIsomorphicLayoutEffect(() => {
    const column = columnRef.current;
    if (column === null) {
      return;
    }
    const observer = new ResizeObserver(measureCards);
    for (const element of Array.from(column.querySelectorAll<HTMLElement>("[data-comment-card]"))) {
      observer.observe(element);
    }
    measureCards();
    return () => observer.disconnect();
  }, [measureCards, targets]);

  const anchorListener = useLatest(onAnchorsChange);
  React.useEffect(() => {
    anchorListener.current?.(anchors);
  }, [anchors, anchorListener]);

  // The first placement is a jump from nowhere to the passage, and animating it drags every
  // card down the screen on load, while every placement AFTER that is a reflow somebody
  // caused and reads better as movement. The flag is written straight onto the column and
  // the transition hangs off it in globals.css, which is the one shape that is neither
  // state (a whole extra render of every card, to change one property) nor a ref read
  // during render (a value the renderer cannot be told has changed).
  //
  // Two frames, not one. Setting the attribute in the layout effect still animates the first
  // placement: a transition starts on the AFTER-change style, and by then the cards have
  // moved to their anchors in the same commit but nothing has been painted yet. One
  // requestAnimationFrame lands before that paint as well, so the second one is what puts
  // the flag after it.
  useIsomorphicLayoutEffect(() => {
    const column = columnRef.current;
    if (column === null || anchors.length === 0) {
      return;
    }
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => column.setAttribute("data-placed", ""));
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [anchors]);

  const capture = React.useCallback(
    (found: SelectionCapture | null) => onSelect?.(found),
    [onSelect],
  );
  useSelectionCapture({
    containerRef: articleRef,
    enabled: selectable && onSelect !== undefined,
    onCapture: capture,
  });

  const anchorMap = React.useMemo(
    () => new Map(anchors.map((anchor) => [anchor.id, anchor])),
    [anchors],
  );
  const placement = placeCards(cards, anchorMap, heights, pivotId);

  return (
    <div className={cn("flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8", className)}>
      <div
        ref={articleRef}
        className="min-w-0 flex-1"
        // One delegated listener rather than handlers on marks that are thrown away and
        // rebuilt on every pass. Pointing at unmarked text reports null, which is how
        // leaving a passage lowers its card.
        onPointerOver={(event) => setHovered(commentIdAt(event.target))}
        onPointerLeave={() => setHovered(null)}
        onClick={(event) => onActivate(commentIdAt(event.target))}
      >
        {article}
      </div>

      <aside aria-label={railLabel} className={cn("w-full shrink-0", RAIL_WIDTH)}>
        <div
          ref={columnRef}
          data-comment-rail=""
          style={{ "--rail-height": `${placement.height}px` } as React.CSSProperties}
          // Below lg the cards are an ordinary stacked list and the inline `top` on each one
          // is inert, because a static element has no top. Above it the column is the
          // positioning context and the height is whatever the placement needs, so the page
          // does not clip the last card.
          className="flex flex-col gap-3 lg:relative lg:block lg:h-(--rail-height) lg:gap-0"
        >
          {cards.map((card) => {
            const anchor = anchorMap.get(card.id);
            const active = live === card.id;
            return (
              <div
                key={card.id}
                data-comment-card={card.id}
                data-unanchored={anchor !== undefined && !anchor.found ? "" : undefined}
                tabIndex={0}
                style={{ top: placement.tops.get(card.id) ?? 0 }}
                className={cn(
                  "rounded-xl bg-card p-3 text-sm ring-1 ring-foreground/10 outline-none lg:absolute lg:left-0 lg:w-full",
                  active
                    ? "z-10 shadow-lg ring-primary/50"
                    : "hover:ring-foreground/20 focus-visible:ring-primary/50",
                )}
                onPointerEnter={() => setHovered(card.id)}
                onPointerLeave={() => setHovered((current) => (current === card.id ? null : current))}
                onFocus={() => onActivate(card.id)}
                onClick={() => onActivate(card.id)}
              >
                {card.body}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

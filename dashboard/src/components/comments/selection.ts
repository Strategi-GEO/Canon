"use client";

import * as React from "react";

/** How much rendered text travels with the selection on each side. Enough to place a
 *  passage that appears twice; small enough that the note stays about the selection. */
const CONTEXT_CHARS = 120;

/** A drag fires selectionchange on nearly every pointer move, and on touch the handles fire
 *  it again for every nudge. Waiting for the stream to go quiet is what turns that into one
 *  capture. Short enough that the card still feels like a response to letting go. */
const SETTLE_MS = 150;

export type SelectionCapture = {
  /** The selected passage, exactly as it reads on screen. */
  text: string;
  /** Rendered text either side, for whoever has to find this passage in the source later. */
  before: string;
  after: string;
  /** Pixels from the container's top to the top of the selection, on the same origin the
   *  anchors use, so a caller can place something at the passage before it has a mark. */
  top: number;
};

/**
 * The latest value of something, without making it a dependency.
 *
 * Every callback here is read from a document listener that must be bound ONCE: rebinding
 * on every render would tear down the listener mid-drag, and requiring callers to memoize
 * their handlers is a rule that gets forgotten and then shows up as a dead composer.
 */
export function useLatest<T>(value: T): React.RefObject<T> {
  const ref = React.useRef(value);
  React.useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/**
 * Captures a text selection inside `containerRef`, on every input a person actually has.
 *
 * THIS LISTENS FOR selectionchange, NOT mouseup alone, and that is the whole point. Selection
 * on a touch device does not end in a mouseup over the passage: a long press opens the
 * handles, dragging a handle adjusts the range, and no mouse event describes any of it. The
 * old mouseup capture therefore made commenting impossible on a tablet, which is where a good
 * share of the reading happens. selectionchange covers mouse, touch and shift-arrow keyboard
 * selection with one listener, and the debounce above is what keeps a drag from firing a
 * hundred captures.
 *
 * A MOUSE DRAG STILL REPORTS ONLY ON RELEASE. The debounce alone is not that: a reader who
 * pauses mid-drag for 150ms has a composer appear under a selection they are still making,
 * and every extension of the drag after that re-fires it. So while the primary mouse button
 * is down, selection changes only mark a capture as pending, and pointerup is what publishes
 * it, immediately, so the card reads as a response to letting go. Touch and keyboard have no
 * such release moment, which is why they keep the settle debounce and nothing else changes.
 *
 * WHEN IT REPORTS null, AND WHEN IT SAYS NOTHING. A collapsed selection inside the article
 * clears the capture: the reader clicked the text, so they are done with that passage. A
 * selection anywhere ELSE on the page is not this article's business and is ignored, which
 * is what keeps focusing the composer's own textarea from wiping the passage the composer
 * was opened for. Guessing which element the selection moved into instead would be the same
 * rule with more ways to get it wrong.
 */
export function useSelectionCapture({
  containerRef,
  enabled,
  onCapture,
  contextChars = CONTEXT_CHARS,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Off, selections mean nothing: a reader copying a sentence for an email never trips a
   *  composer they did not ask for. */
  enabled: boolean;
  onCapture: (capture: SelectionCapture | null) => void;
  contextChars?: number;
}): void {
  const latest = useLatest(onCapture);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    let timer = 0;

    function read() {
      const container = containerRef.current;
      const selection = window.getSelection();
      if (container === null || selection === null || selection.rangeCount === 0) {
        return;
      }
      const anchorNode = selection.anchorNode;
      if (anchorNode === null || !container.contains(anchorNode)) {
        return;
      }
      if (selection.isCollapsed) {
        latest.current(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
        return;
      }
      const text = selection.toString().trim();
      if (text === "") {
        latest.current(null);
        return;
      }

      // Rendered text either side, via range arithmetic rather than an indexOf that would
      // land on the wrong copy of a repeated phrase.
      const pre = range.cloneRange();
      pre.selectNodeContents(container);
      pre.setEnd(range.startContainer, range.startOffset);
      const post = range.cloneRange();
      post.selectNodeContents(container);
      post.setStart(range.endContainer, range.endOffset);

      const rect = range.getBoundingClientRect();
      const base = container.getBoundingClientRect().top - container.scrollTop;
      latest.current({
        text,
        before: pre.toString().replace(/\s+/g, " ").slice(-contextChars).trimStart(),
        after: post.toString().replace(/\s+/g, " ").slice(0, contextChars).trimEnd(),
        top: rect.top - base,
      });
    }

    // Whether the primary mouse button is down, and whether a selection changed under it.
    // Plain locals, not state: they exist only between one press and its release.
    let mouseDown = false;
    let pending = false;

    function onSelectionChange() {
      if (mouseDown) {
        pending = true;
        return;
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(read, SETTLE_MS);
    }

    function onPointerDown(event: PointerEvent) {
      if (event.pointerType === "mouse" && event.button === 0) {
        mouseDown = true;
        pending = false;
      }
    }

    // pointercancel too: a press the browser aborts would otherwise leave mouseDown stuck
    // true and every later selection silently marked pending forever.
    function onPointerEnd(event: PointerEvent) {
      if (event.pointerType !== "mouse" || !mouseDown) {
        return;
      }
      mouseDown = false;
      if (pending) {
        pending = false;
        window.clearTimeout(timer);
        read();
      }
    }

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerEnd);
      document.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [containerRef, enabled, contextChars, latest]);
}

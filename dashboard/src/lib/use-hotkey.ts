"use client";

import * as React from "react";

/**
 * A single global keyboard shortcut.
 *
 * Why the typing guard: an operator naming a client types "k" like any other letter, and a
 * shortcut that fires inside a text field turns their own input against them. So a bare key
 * never fires while focus sits in an editable element. A modified combo (cmd+k) is exempt,
 * because no text field means anything by it.
 *
 * Combo syntax: "k", "mod+k", "shift+/". "mod" is cmd on a Mac and ctrl elsewhere, which is
 * what every operator's fingers already expect from their own platform.
 */
export function useHotkey(
  combo: string,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;

  // The handler is captured in a ref so a caller passing an inline arrow does not tear down
  // and rebind the listener on every single render.
  const handlerRef = React.useRef(handler);
  React.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const parts = combo.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    const wantMod = parts.includes("mod");
    const wantShift = parts.includes("shift");
    const wantAlt = parts.includes("alt");

    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== key) {
        return;
      }

      const hasMod = event.metaKey || event.ctrlKey;
      if (hasMod !== wantMod || event.shiftKey !== wantShift || event.altKey !== wantAlt) {
        return;
      }

      if (!wantMod && isTypingTarget(event.target)) {
        return;
      }

      event.preventDefault();
      handlerRef.current(event);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [combo, enabled]);
}

/** True when focus sits somewhere the operator is composing text. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** The platform never changes under us, so there is nothing to subscribe to. */
const subscribeToNothing = () => () => {};

const readModLabel = () =>
  /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";

/** "⌘K" on a Mac, "Ctrl K" elsewhere. Rendered in hints so the hint matches the keyboard. */
export function useModLabel(): string {
  // useSyncExternalStore rather than an effect: the server has no navigator, and guessing
  // wrong would ship a hint naming a key the operator does not have. This states both
  // snapshots outright, so the server renders "Ctrl" and the client corrects it during
  // hydration without a render cascade.
  return React.useSyncExternalStore(subscribeToNothing, readModLabel, () => "Ctrl");
}

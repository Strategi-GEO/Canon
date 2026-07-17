"use client";

/**
 * The engine-wide session queue, in the topbar, on every route.
 *
 * WHY THIS IS GLOBAL AND NOT A BRAND CARD. The queue is repo-wide: CLIENT_LOCK admits one
 * session at a time across every brand, so the answer to "why has my session not started" is
 * almost always another brand's session. A brand-scoped surface cannot say that, because the
 * fact lives outside the brand. The topbar already owns global engine state, the connection
 * indicator and the mock banner, so the queue belongs in the same place rather than in a
 * seventh nav item or a route that does not exist.
 *
 * It is STATUS, not an action: no accent, no button chrome at rest. It has to open something,
 * so it is a control, but it carries the weight of the connection indicator next to it and
 * never that of Create blogs.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Clock, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { errorLines } from "@/components/clients/engine-error";
import { useNow } from "@/components/create/use-now";
import { formatElapsed } from "@/lib/format";
import { brandHref, useOrgs } from "@/lib/orgs-context";
import { useRuns } from "@/lib/runs-context";
import { ENGINE_SLOTS, clockOf, type Session } from "@/lib/sessions";
import { cn } from "@/lib/utils";

export function SessionsIndicator() {
  const { queue, error, checking } = useRuns();
  const [open, setOpen] = React.useState(false);

  const running = queue.filter((session) => session.state === "running").length;
  const queued = queue.length - running;

  // Nothing known yet: render nothing rather than a skeleton. Most loads have no live session,
  // so a placeholder for a control that usually never appears is furniture flashing on every
  // page load.
  if (checking && error === null) {
    return null;
  }

  /**
   * IDLE RENDERS NOTHING. A permanent "0 sessions" control is a dead thing shouting a number
   * at an operator who has no session and cannot act on it, and it trains the eye to skip the
   * exact spot where a real queue will later appear. Absence is already this product's answer
   * for an idle brand, on the Overview card, so the topbar answers the same way.
   *
   * The `open` clause is what keeps that honest. A sheet open while the last session finishes
   * would otherwise unmount under the operator's cursor, so the control stays mounted as long
   * as it is open and the sheet says plainly that nothing is running.
   */
  if (queue.length === 0 && error === null && !open) {
    return null;
  }

  /**
   * The noun is not decoration. "queued" means two different things in this product: a SESSION
   * queued behind another brand against CLIENT_LOCK, and a TOPIC queued behind the engine's
   * five slots inside a running session. Both appear on a brand Overview at once, this trigger
   * saying "1 session running, 2 queued" and the session card below it saying "2 running, 3
   * queued" about blogs. Without the noun those are two contradictory readings of the same
   * word, and the reader has to open the sheet to learn which is which. One word fixes it.
   */
  const label =
    error !== null
      ? "Sessions unknown"
      : queue.length === 0
        ? "No sessions"
        : queued > 0
          ? `${running} ${running === 1 ? "session" : "sessions"} running, ${queued} queued`
          : `${running} ${running === 1 ? "session" : "sessions"} running`;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        className="machine flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:bg-muted"
        aria-label={`${label}. Open the engine session queue.`}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            error !== null ? "bg-review" : running > 0 ? "bg-ship" : "bg-muted-foreground/50",
          )}
        />
        {label}
      </SheetTrigger>

      {/* Width is left to the primitive: its own data-[side] rules out specify a plain
          max-w utility, so an override here would look intentional and do nothing. gap-0
          is a plain class either way, and the header owns the only rule under itself. */}
      <SheetContent side="right" className="gap-0">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Sessions</SheetTitle>
          <SheetDescription>
            The engine runs one session at a time across every brand, and{" "}
            <span className="machine">{ENGINE_SLOTS}</span> blogs at a time inside that session.
            Every other session waits here, in this order, and starts the moment the one above
            it finishes.
          </SheetDescription>
        </SheetHeader>

        <SessionList onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The queue itself. Split out so the clock only ticks while the sheet is open: the trigger
 * carries counts and no timer, so an idle topbar re-renders once every four seconds on the
 * poll rather than every second forever.
 */
function SessionList({ onNavigate }: { onNavigate: () => void }) {
  // Both halves of one answer, read from the one place that holds it. Taking `error` as a prop
  // while reading `queue` from the context gave a single fact two routes into a component
  // small enough to need neither.
  const { queue, error } = useRuns();
  const now = useNow(true);

  // min-h-0 is what lets this scroll inside the sheet's flex column rather than growing past
  // it: a queue of a dozen sessions must not push its own last row off the bottom.
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error !== null ? (
        // Said, not swallowed. An unread queue rendered as an empty one would claim nothing is
        // running, and the operator would go looking for a stalled engine that is in fact busy.
        // The engine's own words come through: "cannot reach" and "refused" are two different
        // errands.
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-4 text-xs text-review">
          {error.isOffline
            ? "Cannot reach the engine, so the session queue is unknown."
            : "The engine refused the session list, so the queue is unknown."}{" "}
          <span className="machine wrap-break-word text-muted-foreground">
            {errorLines(error).join(" ")}
          </span>
        </p>
      ) : null}

      {queue.length === 0 && error === null ? (
        // Plainly, rather than an empty panel. An operator who opened this asked a question,
        // and "nothing is running" is the answer, not a blank.
        <p className="px-4 py-6 text-xs leading-relaxed text-muted-foreground">
          No sessions are running or queued. The engine is idle, so a session submitted now
          starts immediately.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {queue.map((session) => (
            <SessionRow
              key={session.runId}
              session={session}
              now={now}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One session. The BRAND is the label, because a session belongs to a brand and an operator
 * thinks in brands: the slug is the engine's key and appears only underneath, in machine type,
 * for the operator who needs to match it to a log line.
 */
function SessionRow({
  session,
  now,
  onNavigate,
}: {
  session: Session;
  /** The shared clock. Null until mount, so no elapsed is ever rendered during SSR. */
  now: Date | null;
  onNavigate: () => void;
}) {
  const { findBrand } = useOrgs();

  const found = findBrand(session.clientSlug);
  // A link needs BOTH segments, so an unresolvable brand gets no link rather than a guessed
  // URL. It stays listed: it is genuinely holding or waiting for the lock, and hiding it would
  // make the queue's own length a lie.
  const href = found ? brandHref(found.org.slug, found.brand.slug, "/create") : null;
  const name = found?.brand.name ?? session.clientSlug;

  const clock = clockOf(session);
  const elapsed = now === null || clock === null ? null : formatElapsed(clock.since, now);
  const queued = session.state === "queued";

  const body = (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="machine text-xs text-muted-foreground">{session.clientSlug}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        {/* Colour never carries this alone: the word "Queued" or "Running" says it, and the
            dot only repeats it for the operator scanning the list. */}
        <span className="flex items-center gap-1.5">
          {queued ? (
            <Clock className="size-3 shrink-0" aria-hidden />
          ) : (
            <Loader2
              className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
          )}
          <span className={cn(!queued && "text-foreground")}>
            {queued ? "Queued" : "Running"}
          </span>
        </span>

        <span>
          <span className="machine text-foreground">{session.topicCount}</span>{" "}
          {session.topicCount === 1 ? "blog" : "blogs"}
        </span>

        {/* Two different questions, so two different words. A queued session has run for
            nothing and waited for however long, and it must never carry a "running for"
            clock. clockOf is what decides which instant either state may measure from. */}
        {elapsed !== null ? (
          <span className="machine">
            {clock?.measures === "waiting" ? `waiting ${elapsed}` : `running ${elapsed}`}
          </span>
        ) : null}
      </div>

      {queued ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          No blog in this session has started. It waits on the session above it, not on
          anything of its own.
        </p>
      ) : null}
    </>
  );

  if (href === null) {
    return <li className="px-4 py-3">{body}</li>;
  }

  return (
    <li>
      {/* The whole row is the link, to the run view on that brand's Create tab. That view
          already exists and already re-attaches, so this routes to it rather than rebuilding
          it. No accent: a queue is a list of statuses, and the one accent action in this app
          is Create blogs. */}
      <Link
        href={href}
        onClick={onNavigate}
        className="flex items-start gap-2 px-4 py-3 transition-colors hover:bg-muted/60"
      >
        <span className="min-w-0 flex-1">{body}</span>
        <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}

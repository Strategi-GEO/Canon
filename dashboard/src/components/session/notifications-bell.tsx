"use client";

/**
 * What finished while the operator was not looking, in the topbar, on every route.
 *
 * WHY IT IS GLOBAL. The work it reports is global: a blog run belongs to a brand, but the reason
 * to be told about it is that the operator is somewhere else entirely, most often on another
 * brand. A surface scoped to the brand it concerns is exactly the one place the news is not
 * needed, so this sits beside the session queue and the connection indicator, which are already
 * the topbar's engine-wide state.
 *
 * It is STATUS, not an action: no accent and no button chrome at rest, carrying the weight of the
 * indicator next to it and never that of Create blogs. The count is the one thing that raises its
 * voice, and only when it has something to say.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Bell, CircleAlert, FileText, Map as MapIcon, Sparkles } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useNow } from "@/components/create/use-now";
import { formatRelative } from "@/lib/format";
import { copyFor, type AppNotification, type NotificationKind } from "@/lib/notifications";
import { useNotifications } from "@/lib/notifications-context";
import { useOrgs } from "@/lib/orgs-context";
import { cn } from "@/lib/utils";

const ICON_FOR: Record<NotificationKind, typeof Bell> = {
  run: FileText,
  describe: Sparkles,
  roadmap: MapIcon,
};

export function NotificationsBell() {
  const { log, unread, markAllRead } = useNotifications();
  const [open, setOpen] = React.useState(false);

  /**
   * NOTHING RENDERS NOTHING. A permanent bell reading zero is a dead thing shouting a number at
   * an operator who has nothing to read and cannot act on it, and it trains the eye to skip the
   * exact spot where real news will later appear. Absence is already this product's answer for an
   * idle queue, one control to the right of this one, so the bell answers the same way.
   *
   * The `open` clause keeps that honest: a sheet open while the log is cleared would unmount
   * under the operator's cursor.
   */
  if (log.length === 0 && !open) {
    return null;
  }

  const label =
    unread === 0
      ? `${log.length} ${log.length === 1 ? "notification" : "notifications"}, none new`
      : `${unread} new ${unread === 1 ? "notification" : "notifications"}`;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Opening it IS reading it, which is the one gesture every bell shares. Marking on close
        // instead would leave the count contradicting the list the operator is looking at.
        if (next) {
          markAllRead();
        }
      }}
    >
      <SheetTrigger
        className="machine relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:bg-muted"
        aria-label={`${label}. Open notifications.`}
      >
        <Bell className="size-3.5" aria-hidden />
        {/* The count renders only when there IS one. A "0" here would be furniture, and the
            unread state is the only reason this control raises its voice above the row it sits
            in. */}
        {unread > 0 ? (
          <span
            aria-hidden
            className="min-w-4 rounded-full bg-ship px-1 text-center text-[10px] leading-4 font-medium text-background"
          >
            {unread}
          </span>
        ) : null}
      </SheetTrigger>

      <SheetContent side="right" className="gap-0">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>
            Every Claude Code query that finished while this tab was open: a blog run, a drafted
            description. Anything that finished before you got here lives on the brand it belongs
            to, not here.
          </SheetDescription>
        </SheetHeader>

        <NotificationList onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}

/**
 * The log itself. Split out so the clock only ticks while the sheet is open: the trigger carries
 * a count and no timer, so an idle topbar never re-renders on a clock it is not showing.
 */
function NotificationList({ onNavigate }: { onNavigate: () => void }) {
  const { log } = useNotifications();
  const now = useNow(true);

  // min-h-0 is what lets this scroll inside the sheet's flex column rather than growing past it.
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {log.length === 0 ? (
        // Plainly, rather than an empty panel. An operator who opened this asked a question.
        <p className="px-4 py-6 text-xs leading-relaxed text-muted-foreground">
          Nothing has finished yet. Start a blog run or draft a description, and whatever lands
          while you are on another page shows up here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {log.map((note) => (
            <NotificationRow key={note.id} note={note} now={now} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NotificationRow({
  note,
  now,
  onNavigate,
}: {
  note: AppNotification;
  /** The shared clock. Null until mount, so no relative time is ever rendered during SSR. */
  now: Date | null;
  onNavigate: () => void;
}) {
  const { findBrand } = useOrgs();

  const found = findBrand(note.brandSlug);
  const name = found?.brand.name ?? note.brandSlug;
  const { title, body } = copyFor(note, name);
  const failed = note.error !== null;
  const Icon = failed ? CircleAlert : ICON_FOR[note.kind];

  const content = (
    <>
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", failed ? "text-fail" : "text-muted-foreground")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {/* The engine's own key, in machine type, for the operator matching this to a log
              line. The brand NAME is what the sentence below reads. */}
          <span className="machine text-xs text-muted-foreground">{note.brandSlug}</span>
        </span>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{body}</p>
        {now !== null ? (
          <span className="machine mt-1 block text-xs text-muted-foreground">
            {formatRelative(note.observedAt, now)}
          </span>
        ) : null}
      </span>
    </>
  );

  if (note.href === null) {
    // A link needs both segments, so an unresolvable brand gets no link rather than a guessed
    // URL. The row stays: the work genuinely finished, and hiding it would make the log a lie.
    return <li className="flex items-start gap-2 px-4 py-3">{content}</li>;
  }

  return (
    <li>
      <Link
        href={note.href}
        onClick={onNavigate}
        className="flex items-start gap-2 px-4 py-3 hover:bg-muted/60"
      >
        {content}
        <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}

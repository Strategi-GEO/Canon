"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  copyFor,
  unreadOf,
  type AppNotification,
  type NotificationKind,
} from "@/lib/notifications";
import { brandHref, useOrgs } from "@/lib/orgs-context";

/**
 * The bell's log: every Claude Code query that finished while this operator was watching.
 *
 * A SINK, and nothing else. It knows how to record an event, count the unread ones and say them
 * out loud; it knows nothing about runs, drafts or roadmaps. Each producer watches its own
 * engine feed and calls notify(), which is what lets the roadmap generator light this up later
 * without a line changing here.
 *
 * ONE RULE: every finished query toasts and adds +1, from anywhere, with no exception for the
 * operator who was already on the page it concerns. Opening the bell clears the count. That is
 * the whole of it, and the uniformity is the feature: the number always means "this many things
 * finished since I last looked", never "this many things finished somewhere I was not".
 *
 * WHY THIS IS NOT A PUSH NOTIFICATION, stated plainly because the word "notification" invites
 * the assumption. There is no Notification API, no service worker and no permission prompt: the
 * engine runs on the operator's own machine and every producer reads it by polling a tab that is
 * on screen. lib/runs-context stops polling on a hidden tab, deliberately, because six operators'
 * idle tabs hammering the same asyncio loop that runs blog generation is a regression that
 * already happened once. A bell does not justify reintroducing it. "As soon as a query finishes"
 * therefore means "within one poll of the operator looking at this tab", which is exactly what a
 * badge whose whole job is to be seen when they look actually needs.
 *
 * NOTHING IS PERSISTED. The log is this tab's record of what it watched happen, so a reload
 * starting empty is correct rather than lossy: a run that finished before this tab existed is
 * history, and the Blogs tab is where history lives. Storing it would also outlive the engine
 * that produced it, because runner.RUNS is process memory and an engine restart makes every
 * stored run id unresolvable.
 */

type NotificationsState = {
  /** Newest first. The order the bell renders and the order the operator reads. */
  log: readonly AppNotification[];
  unread: number;
  /**
   * Records one finished job. Safe to call twice with the same id: a poll that re-reports a
   * settled job must not list it twice, so the id is the identity and the second call is a
   * no-op.
   */
  notify: (input: NotifyInput) => void;
  /** The conventional bell gesture: opening it is reading it. */
  markAllRead: () => void;
};

export type NotifyInput = {
  kind: NotificationKind;
  /** The engine's brand key. Resolved to a name and a link here, once. */
  brandSlug: string;
  /** The part of the id that makes it unique within its kind: a run id, or a brand slug. */
  key: string;
  /** What this kind counts, per AppNotification.topicCount: blogs for a run, questions for
   *  "answers", suggestions for "changes_requested". Null for kinds that count nothing. */
  topicCount?: number | null;
  /** The engine's own words on a failure, or null. Never "". */
  error?: string | null;
};

const NotificationsContext = React.createContext<NotificationsState | null>(null);

/** Where each kind's news actually renders, which is where its notification links to. */
const SECTION_FOR: Record<NotificationKind, string> = {
  // NOT /create. A finished run's Create tab re-attaches only while the run is live, so it
  // renders the pick-some-rows state and not the summary. Blogs is the only route that shows
  // what the run produced.
  run: "/blogs",
  describe: "",
  roadmap: "/roadmap",
  // Client-answered questions render on the blog rows and in the drawer's rerun strip.
  answers: "/blogs",
  // Both halves of the client review loop land on the blog list too: the delivery chips
  // say which blog the client acted on, and its stage page is one click from there.
  changes_requested: "/blogs",
  client_approved: "/blogs",
};

const EMPTY: AppNotification[] = [];

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [log, setLog] = React.useState<readonly AppNotification[]>(EMPTY);
  const { findBrand } = useOrgs();

  // findBrand changes identity whenever the org list reloads, and notify() must not: a producer
  // holding a stale notify would keep firing into a dead closure. Written in an effect rather
  // than during render, per this codebase's lint rule: a ref is not render data, and notify()
  // reads it from a poll settling well after commit.
  const findBrandRef = React.useRef(findBrand);
  React.useEffect(() => {
    findBrandRef.current = findBrand;
  });

  const notify = React.useCallback((input: NotifyInput) => {
    const id = `${input.kind}:${input.key}`;
    const found = findBrandRef.current(input.brandSlug);
    const note: AppNotification = {
      id,
      kind: input.kind,
      brandSlug: input.brandSlug,
      observedAt: new Date().toISOString(),
      // A link needs BOTH segments, so an unresolvable brand gets no link rather than a guessed
      // URL. It still gets listed: the work genuinely finished, and hiding it would make the
      // log a lie about what happened.
      href: found ? brandHref(found.org.slug, found.brand.slug, SECTION_FOR[input.kind]) : null,
      /*
        ALWAYS UNREAD, whatever page the operator is on.

        Every finished query is +1, with no exception for "you were already looking at it". The
        exception existed and was removed on purpose: it made the number mean different things
        depending on where its owner happened to be standing when it arrived, and a count you have
        to reconstruct the history of is one you stop trusting. Opening the bell is the only thing
        that clears it, which is a rule that fits in one sentence and needs no diagram.
      */
      read: false,
      topicCount: input.topicCount ?? null,
      error: input.error ?? null,
    };

    setLog((current) => {
      // The producers poll, and a poll re-reads settled work every time it runs. Identity is the
      // id, so the second sighting of one finished job is not news.
      if (current.some((existing) => existing.id === id)) {
        return current;
      }
      return [note, ...current];
    });

    const { title, body } = copyFor(note, found?.brand.name ?? input.brandSlug);
    // The toast fires every time, on every route, exactly as the count rises every time. One
    // finished query, one line on screen for a few seconds, one +1. No conditions on either.
    const settled = note.error === null ? toast.success : toast.error;
    settled(title, { description: body });
  }, []);

  const markAllRead = React.useCallback(() => {
    setLog((current) =>
      current.some((note) => !note.read)
        ? current.map((note) => (note.read ? note : { ...note, read: true }))
        : current,
    );
  }, []);

  const value = React.useMemo<NotificationsState>(
    () => ({ log, unread: unreadOf(log), notify, markAllRead }),
    [log, notify, markAllRead],
  );

  return (
    <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsState {
  const ctx = React.useContext(NotificationsContext);
  if (!ctx) {
    throw new Error("useNotifications must be used inside NotificationsProvider");
  }
  return ctx;
}

"use client";

import * as React from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { GeoMockBanner } from "@/components/shell/geo-mock-banner";
import { CommandPaletteProvider } from "@/components/shell/command-palette";
import { DocumentTitle } from "@/components/shell/document-title";
import { RunNotifier } from "@/components/session/run-notifier";
import { OrgsProvider } from "@/lib/orgs-context";
import { ClientsProvider } from "@/lib/clients-context";
import { DescribeProvider } from "@/lib/describe-context";
import { NotificationsProvider } from "@/lib/notifications-context";
import { RunsProvider } from "@/lib/runs-context";

/**
 * OrgsProvider is the single fetch of the hierarchy. ClientsProvider sits inside it and only
 * adapts that same data into the flat client list, so the two can never disagree about which
 * brands exist or which one is active.
 *
 * RunsProvider is the single read of the engine-wide session queue, and it sits at the same
 * height for the same reason: the queue spans every brand, the topbar indicator and a brand's
 * Overview card both need it, and two reads of one list is how this codebase grew a phantom
 * row. It is INSIDE OrgsProvider because a run names a brand by slug and every consumer has to
 * resolve that slug to a brand before it can render a name or a link.
 *
 * The palette sits INSIDE OrgsProvider because it navigates the same hierarchy the sidebar
 * does, and wrapping the whole shell means the shortcut answers on every route rather than
 * only where someone remembered to mount it.
 *
 * NotificationsProvider is the bell's log, and it is INSIDE RunsProvider because the fact it
 * reports is derived from that one poll rather than from a second read of the same list, and
 * inside OrgsProvider because a finished run names its brand by slug and the log has to resolve
 * that to a name and a link. DescribeProvider sits inside it because a settled draft is one of
 * the things it announces. Both are above every route on purpose: the whole point is to be told
 * about work that finished while the page that started it was long gone.
 *
 * RunNotifier renders nothing. It is the seam between the run list and the log, mounted here
 * beside DocumentTitle because both are headless readers of state the shell already holds.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <OrgsProvider>
      <ClientsProvider>
        <RunsProvider>
          <NotificationsProvider>
            <DescribeProvider>
              <CommandPaletteProvider>
                <DocumentTitle />
                <RunNotifier />
                <Sidebar />
                <div className="flex min-h-dvh flex-col lg:pl-60">
                  <Topbar />
                  <GeoMockBanner />
                  <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
                </div>
              </CommandPaletteProvider>
            </DescribeProvider>
          </NotificationsProvider>
        </RunsProvider>
      </ClientsProvider>
    </OrgsProvider>
  );
}

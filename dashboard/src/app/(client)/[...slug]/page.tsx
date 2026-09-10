"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { resolveClientRoute } from "@/portal/nav";
import { usePortal } from "@/portal/portal-context";
import { BlogDetail, BlogsLibrary, BrandOverview, OrgChooser } from "@/portal/views";
import { ChannelLibraryView, ChannelPostDetailView } from "@/portal/channel-views";
import type { RepurposeChannel } from "@/types";
import { QuestionsView } from "@/portal/questions-view";
import { RoadmapView } from "@/portal/roadmap-view";
import { ReportsView } from "@/portal/reports-view";
import { detailText } from "@/portal/api";
import { Button } from "@/components/ui/button";

/**
 * The nav sections that render a channel view. Derived from the RepurposeChannel union rather
 * than written out, so a new channel cannot be added to the type, the nav and the portal data
 * layer and then silently 404 here because this one arm was never widened. The cast below is
 * sound for the same reason: membership in this set IS the proof that the section suffix is a
 * channel.
 */
const CHANNEL_SECTIONS = new Set<string>(
  (["linkedin", "medium", "bluesky", "x"] satisfies RepurposeChannel[]).map((c) => `/${c}`),
);

/**
 * The client portal's one page. Every client URL lands here, and the resolver classifies it
 * against the caller's own orgs (single-brand -> /{brand}, multi -> /{org}/{brand}), because a
 * bare slug is an org or a brand only relative to who is asking. This file only dispatches;
 * every view it renders is a prop-driven component in @/portal/views. The (client) layout
 * provides the shell and the operator-eject, so nothing here worries about the frame or role.
 */
export default function ClientCatchAll() {
  const pathname = usePathname();
  const router = useRouter();
  const { orgs, loading, error, refresh } = usePortal();

  // The URL cannot be classified until the org list is in hand, so hold on the loader while
  // it loads rather than momentarily rendering a "not found" for a real brand.
  const route = loading ? null : resolveClientRoute(pathname, orgs);

  React.useEffect(() => {
    if (route?.kind === "redirect") {
      router.replace(route.to);
    }
  }, [route, router]);

  if (error !== null) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
        <p className="text-sm font-medium">Could not load your workspace</p>
        <p className="mt-1 text-xs text-muted-foreground">{detailText(error)}</p>
        <Button className="mt-4" variant="outline" size="sm" onClick={refresh}>
          Try again
        </Button>
      </div>
    );
  }

  if (route === null || route.kind === "redirect") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" aria-busy>
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only" role="status">
          Loading
        </span>
      </div>
    );
  }

  if (route.kind === "not-found") {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
        <p className="text-sm font-medium">This page is not available</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The link may be wrong, or it may belong to another organisation&apos;s account.
        </p>
        <Button className="mt-4" variant="outline" size="sm" onClick={() => router.replace("/")}>
          Back to your workspace
        </Button>
      </div>
    );
  }

  if (route.kind === "org-chooser") {
    return <OrgChooser org={route.org} />;
  }

  // route.kind === "brand"
  if (route.section.startsWith("/blogs")) {
    return route.topic !== null ? (
      <BlogDetail org={route.org} brand={route.brand} topic={route.topic} />
    ) : (
      <BlogsLibrary org={route.org} brand={route.brand} />
    );
  }
  if (CHANNEL_SECTIONS.has(route.section)) {
    const channel = route.section.slice(1) as RepurposeChannel;
    return route.topic !== null ? (
      <ChannelPostDetailView
        key={`${route.brand}:${channel}:${route.topic}`}
        org={route.org}
        brand={route.brand}
        channel={channel}
        topic={route.topic}
      />
    ) : (
      <ChannelLibraryView
        key={`${route.brand}:${channel}`}
        org={route.org}
        brand={route.brand}
        channel={channel}
      />
    );
  }
  if (route.section === "/roadmap") {
    return <RoadmapView org={route.org} brand={route.brand} />;
  }
  // No org prop: the discovery form reads only its own brand's sent questions and links nowhere.
  // Keyed on the brand so switching brand remounts fresh rather than showing one brand's answers
  // in another brand's boxes while the next load lands.
  if (route.section === "/questions") {
    return <QuestionsView key={route.brand} brand={route.brand} />;
  }
  // No org prop: the reports view reads only its own brand's shared reports and links nowhere
  // into the blog library.
  if (route.section === "/reports") {
    // key on the brand so switching brand remounts fresh (no stale report flashing while the
    // next brand's data loads), which is what the in-effect reset used to do.
    return <ReportsView key={route.brand} brand={route.brand} />;
  }
  // No /resources branch: resources are admin-only (migration 024), and the resolver no longer
  // classifies "resources" as a section, so that URL is not-found before it reaches here.
  return <BrandOverview org={route.org} brand={route.brand} />;
}

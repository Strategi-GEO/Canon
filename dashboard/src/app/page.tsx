"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, LogOut, RefreshCw, Settings } from "lucide-react";
import { getSession, signOut } from "@/lib/session";
import { api, ApiError } from "@/portal/api";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/shell/settings-dialog";
import { HOSTED_READONLY } from "@/lib/hosted";

/**
 * The site root of the ONE app, a signpost and never a page: the interface a caller sees is
 * decided by their account, so the root only routes them. An operator goes to /admin; a
 * client goes to their own brand space, whose URL depends on how many brands their org has
 * (single-brand -> /{brand}, multi -> /{org}). Everything here is same-origin (/api/me,
 * /api/overview), so the client path never touches the engine.
 */
export default function RootPage() {
  const router = useRouter();
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (getSession() === null) {
      router.replace("/login");
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const me = await api.me(controller.signal);
        if (controller.signal.aborted) return;
        if (me.is_admin) {
          router.replace("/admin");
          return;
        }
        const overview = await api.overview(controller.signal);
        if (controller.signal.aborted) return;
        const orgs = overview.orgs;
        if (orgs.length === 0) {
          setMessage(
            "No organisation is linked to this account yet. Ask your Strategi contact to connect it.",
          );
          return;
        }
        // A client login belongs to one org; a rare multi-org login lands on its first.
        const org = orgs[0];
        router.replace(
          org.brands.length === 1
            ? `/${encodeURIComponent(org.brands[0].slug)}`
            : `/${encodeURIComponent(org.slug)}`,
        );
      } catch (cause) {
        if (controller.signal.aborted) return;
        // A 401 is handled by the api layer (it clears the session and lands on /login). Any
        // OTHER failure means the session is still valid but this same-origin read could not
        // resolve the role, so send a logged-in operator to the dashboard rather than strand
        // them on a chrome-free root: /admin mounts the shell (Topbar logout, Sidebar settings)
        // and reaches the engine directly, so it works even when this same-origin read does not.
        if (cause instanceof ApiError && cause.status === 401) return;
        router.replace("/admin");
      }
    })();
    return () => controller.abort();
  }, [router]);

  if (message !== null) {
    return (
      <div className="mx-auto mt-24 max-w-md rounded-xl border bg-card p-6 text-center">
        <p className="text-sm font-medium">One moment</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
        {/* NEVER A DEAD END. This route is chrome-free by design (the root layout mounts no
            Topbar and no Sidebar; /admin/* mounts them in its own layout), so when the workspace
            cannot open, the only escapes are the ones rendered right here. Without them a failed
            /api/me strands an operator on a card whose only affordance is the browser. Refresh
            retries, Settings reaches the app/update panel (desktop only, same dialog the sidebar
            opens), and Log out clears a possibly-stale session and returns to /login. None of
            these depend on the fetch that just failed. */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            <RefreshCw data-icon="inline-start" aria-hidden />
            Refresh
          </Button>
          {!HOSTED_READONLY ? (
            <SettingsDialog
              trigger={
                <Button variant="outline" size="sm">
                  <Settings data-icon="inline-start" aria-hidden />
                  Settings
                </Button>
              }
            />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Fire-and-forget revoke inside signOut; the local clear is what matters and the
              // redirect must not wait on a network round trip that may never answer.
              signOut();
              router.replace("/login");
            }}
          >
            <LogOut data-icon="inline-start" aria-hidden />
            Log out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      <span className="sr-only" role="status">
        Opening your workspace
      </span>
    </div>
  );
}

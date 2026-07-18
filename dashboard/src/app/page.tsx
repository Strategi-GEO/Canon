"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { getSession } from "@/lib/session";
import { api, ApiError } from "@/portal/api";

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
        // A 401 is handled by the api layer (it clears the session and lands on /login).
        if (!(cause instanceof ApiError && cause.status === 401)) {
          setMessage("Could not open your workspace. Please refresh to try again.");
        }
      }
    })();
    return () => controller.abort();
  }, [router]);

  if (message !== null) {
    return (
      <div className="mx-auto mt-24 max-w-md rounded-xl border bg-card p-6 text-center">
        <p className="text-sm font-medium">One moment</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
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

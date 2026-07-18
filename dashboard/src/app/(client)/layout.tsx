"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { PortalShell } from "@/portal/shell";
import { api } from "@/portal/api";
import { getSession } from "@/lib/session";

/**
 * The CLIENT portal's shell, mounted for every route the admin zone and the login do not
 * claim. PortalShell already sends a signed-out caller to /login; this wrapper adds the other
 * half of the role gate: an OPERATOR who lands on a client URL is bounced to /admin, so the
 * two interfaces never bleed into each other. The role check is same-origin /api/me, never the
 * engine, so the client interface stays engine-less exactly as it must on Vercel.
 */
export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  React.useEffect(() => {
    if (getSession() === null) {
      return; // PortalShell owns the signed-out redirect; nothing to check yet.
    }
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then((me) => {
        if (!controller.signal.aborted && me.is_admin) {
          router.replace("/admin");
        }
      })
      .catch(() => {
        // A 401 is handled by the api layer (it clears the session and lands on /login).
        // Anything else fails open to PortalShell, which still renders only what RLS allows.
      });
    return () => controller.abort();
  }, [router]);

  return <PortalShell>{children}</PortalShell>;
}

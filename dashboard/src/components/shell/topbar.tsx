"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SidebarBody } from "@/components/shell/sidebar";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { pageTitle, parseBrandPath } from "@/components/shell/nav";
import { NotificationsBell } from "@/components/session/notifications-bell";
import { SessionsIndicator } from "@/components/session/sessions-indicator";
import { ApiError } from "@/lib/api";
import { useOrgs } from "@/lib/orgs-context";
import { getSession, signOut, subscribeSession } from "@/lib/session";
import { cn } from "@/lib/utils";

export function Topbar() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const { findOrg, loading, error } = useOrgs();

  // Read straight off the route rather than off any stored selection, so the trail always
  // describes the page actually on screen.
  const parts = parseBrandPath(pathname);
  const org = parts ? findOrg(parts.org) : null;
  const brand = org?.brands.find((b) => b.slug === parts?.brand) ?? null;

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-card px-4 sm:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
            <Menu aria-hidden />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 gap-0 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
        {pageTitle(pathname)}
      </h1>

      <div className="flex items-center gap-3">
        {/* Ordered by how much each one has to say. A finished run is NEWS and outranks the
            queue, which is state, which outranks "Engine connected", which is furniture that only
            earns attention when it stops saying that. All three are global engine state, which is
            why they are here and not in a brand's nav. */}
        <NotificationsBell />
        <SessionsIndicator />
        <ConnectionIndicator loading={loading} error={error} />
        {brand && org ? (
          <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            {/* Only worth showing when the org is more than the brand under another name. */}
            {org.brands.length > 1 ? (
              <>
                <span className="max-w-32 truncate">{org.name}</span>
                <span aria-hidden>/</span>
              </>
            ) : null}
            <span className="max-w-40 truncate text-foreground">{brand.name}</span>
          </span>
        ) : null}
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}

/**
 * Who is signed in, and the one door out. Last in the row because it is the most global
 * thing here: everything else describes the engine or the page, this describes the person.
 * The email is display only and hides on narrow screens; the sign-out button never does,
 * because a control that exists only at some widths is a control an operator cannot find.
 */
function UserMenu() {
  const router = useRouter();
  const [email, setEmail] = React.useState<string | null>(null);

  // Read in an effect, never during render: the first render is also the SSR render, and
  // there is no localStorage there to read a session from.
  React.useEffect(() => {
    const read = () => setEmail(getSession()?.user.email ?? null);
    read();
    return subscribeSession(read);
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      {email !== null ? (
        <span
          className="hidden max-w-44 truncate text-xs text-muted-foreground md:inline"
          title={email}
        >
          {email}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        title="Sign out"
        onClick={() => {
          // Revoke is fire-and-forget inside signOut; the local clear is what matters, and
          // the redirect must not wait on a network round trip that may never answer.
          signOut();
          router.replace("/login");
        }}
      >
        <LogOut aria-hidden />
      </Button>
    </div>
  );
}

/**
 * An unreachable engine and a refusing engine are different problems and must read
 * differently: one means go and start the engine, the other means the engine is up and said
 * no. Collapsing both into "cannot reach" sends an operator hunting for a dead process that
 * is in fact running and answering.
 */
function ConnectionIndicator({ loading, error }: { loading: boolean; error: ApiError | null }) {
  const label = loading
    ? "Checking the engine"
    : error === null
      ? "Engine connected"
      : error.isOffline
        ? "Cannot reach the engine"
        : "Engine refused a request";

  return (
    <span
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          loading
            ? "bg-muted-foreground/50"
            : error === null
              ? "bg-ship"
              : error.isOffline
                ? "bg-fail"
                : "bg-review",
        )}
      />
      <span className="hidden md:inline">{label}</span>
      <span className="sr-only md:hidden">{label}</span>
    </span>
  );
}

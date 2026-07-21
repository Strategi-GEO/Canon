"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { brandHref, useOrgs } from "@/lib/orgs-context";
import { parseBrandPath } from "@/components/shell/nav";
import type { Client } from "@/types";

/**
 * The flat client list, ADAPTED from the org grouping rather than fetched again.
 *
 * This is deliberately not a second source of truth. `clients` is every brand across every
 * org, taken from OrgsProvider, and the active brand is read from the ROUTE, because a URL is
 * shareable, refresh proof and back button proof while a stored slug is none of those and
 * would fight the address bar the moment the two disagreed.
 *
 * `setActiveSlug` therefore navigates: selecting a brand and being on that brand's page are
 * the same act now, so the two cannot desync.
 */
type ClientsState = {
  clients: Client[];
  activeSlug: string | null;
  activeClient: Client | null;
  loading: boolean;
  /** The engine's own reason the list could not load, or null when it loaded. */
  error: ApiError | null;
  setActiveSlug: (slug: string) => void;
  refresh: () => Promise<void>;
};

const ClientsContext = React.createContext<ClientsState | null>(null);

export function ClientsProvider({ children }: { children: React.ReactNode }) {
  const { brands, findBrand, loading, error, refresh } = useOrgs();
  const pathname = usePathname();
  const router = useRouter();

  const activeSlug = parseBrandPath(pathname)?.brand ?? null;

  const setActiveSlug = React.useCallback(
    (slug: string) => {
      // Routing IS the selection. A slug the engine has never listed cannot be routed to,
      // and doing nothing beats sending the operator to a page that cannot exist.
      const located = findBrand(slug);
      if (located) {
        router.push(brandHref(located.org.slug, located.brand.slug));
      }
    },
    [findBrand, router],
  );

  const value = React.useMemo<ClientsState>(() => {
    return {
      clients: brands,
      activeSlug,
      activeClient: brands.find((client) => client.slug === activeSlug) ?? null,
      loading,
      error,
      setActiveSlug,
      refresh,
    };
  }, [brands, activeSlug, loading, error, setActiveSlug, refresh]);

  return <ClientsContext.Provider value={value}>{children}</ClientsContext.Provider>;
}

export function useClients(): ClientsState {
  const ctx = React.useContext(ClientsContext);
  if (!ctx) {
    throw new Error("useClients must be used inside ClientsProvider");
  }
  return ctx;
}

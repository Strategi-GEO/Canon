"use client";

import * as React from "react";
import { ApiError, api } from "@/portal/api";
import type { Overview, PortalBlogCard, PortalOrg } from "@/portal/types";

/**
 * The one fetch of the client's world, mounted at shell height exactly as the admin
 * dashboard mounts OrgsProvider: the sidebar, the topbar breadcrumb, and every page read
 * the same /api/overview result, so no two surfaces can disagree about which brands exist
 * or what state a blog is in. Pages call refresh() after an act that changes the record
 * (answering), and the whole tree re-reads together.
 */

type PortalState = {
  orgs: PortalOrg[];
  brands: { slug: string; name: string; org: string; domain: string; industry: string; description: string }[];
  blogs: PortalBlogCard[];
  loading: boolean;
  error: ApiError | null;
  refresh: () => void;
  /**
   * Whether an org has exactly one brand, which is what decides a URL's shape everywhere
   * (single-brand -> /{brand}, multi -> /{org}/{brand}). Kept here so a card or a nav row
   * builds the right link from the same org list the shell already holds, never a second
   * read. Unknown orgs answer false: the safe default is the fuller /{org}/{brand} form.
   */
  isSingleBrand: (orgSlug: string) => boolean;
};

const PortalContext = React.createContext<PortalState | null>(null);

export function PortalDataProvider({ children }: { children: React.ReactNode }) {
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api
      .overview(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setOverview(data);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) {
          return;
        }
        if (cause instanceof ApiError) {
          setError(cause);
        } else if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(new ApiError(0, String(cause)));
        }
      });
    return () => controller.abort();
  }, [attempt]);

  const refresh = React.useCallback(() => setAttempt((n) => n + 1), []);

  const value = React.useMemo<PortalState>(() => {
    const orgs = overview?.orgs ?? [];
    const singleByOrg = new Map(orgs.map((org) => [org.slug, org.brands.length === 1]));
    return {
      orgs,
      brands: orgs.flatMap((org) => org.brands.map((brand) => ({ ...brand, org: org.slug }))),
      blogs: overview?.blogs ?? [],
      loading: overview === null && error === null,
      error,
      refresh,
      isSingleBrand: (orgSlug: string) => singleByOrg.get(orgSlug) ?? false,
    };
  }, [overview, error, refresh]);

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalState {
  const state = React.useContext(PortalContext);
  if (state === null) {
    throw new Error("usePortal must be used inside PortalDataProvider");
  }
  return state;
}

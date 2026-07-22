"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import { LAST_ORG_KEY } from "@/lib/config";
import type { Client, ClientsResponse, Org, OrgsResponse } from "@/types";

/** A brand together with the org it belongs to. Resolving one always resolves the other. */
export type BrandLocation = {
  org: Org;
  brand: Client;
};

type OrgsState = {
  orgs: Org[];
  /** Every brand across every org, flat. The org grouping is the only thing above it. */
  brands: Client[];
  loading: boolean;
  /** The engine's own reason the list could not load, or null when it loaded. */
  error: ApiError | null;
  refresh: () => Promise<void>;
  findOrg: (slug: string) => Org | null;
  /**
   * Finds a brand by slug ACROSS every org, which is what makes a stale link recoverable:
   * a brand that moved org can be redirected to where it actually lives instead of 404ing.
   */
  findBrand: (slug: string) => BrandLocation | null;
};

const OrgsContext = React.createContext<OrgsState | null>(null);

/**
 * Groups a flat client list into single-brand orgs.
 *
 * This is the documented default made local: a client with no "organisation" key in its
 * gates.json IS its own org, so a client list alone is enough to render the whole
 * hierarchy. It runs when GET /api/orgs is not there yet (the endpoint ships separately),
 * which keeps every page rendering against an engine that is mid change.
 *
 * It is a derivation of the same clients, not a second source of truth: the moment
 * /api/orgs answers, that grouping wins outright and this never runs again.
 */
function deriveOrgs(clients: Client[]): Org[] {
  const byOrg = new Map<string, Org>();

  for (const client of clients) {
    const slug = client.organisation?.slug ?? client.slug;
    const name = client.organisation?.name ?? client.name;
    const existing = byOrg.get(slug);
    if (existing) {
      existing.brands.push(client);
    } else {
      byOrg.set(slug, { slug, name, brands: [client] });
    }
  }

  return [...byOrg.values()];
}

/** Orgs alphabetically, and brands alphabetically inside each, so a menu never reshuffles. */
function sortOrgs(orgs: Org[]): Org[] {
  return orgs
    .map((org) => ({
      ...org,
      brands: [...org.brands].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fills in each brand's preflight from the client list.
 *
 * GET /api/orgs does not decorate its brands with preflight; GET /api/clients does. Without
 * this, every brand arrives with preflight undefined, PreflightNote reads that as "nothing to
 * warn about" and the amber note silently never renders. That failure mode is the worst kind
 * available here: an unreviewed canonical-facts.md would look exactly like a reviewed one,
 * and preflight is the gate that stops an unreviewed fact base reaching a real blog. A
 * missing warning must never be indistinguishable from no warning.
 *
 * A brand that already carries its own preflight keeps it, so this costs nothing the day the
 * engine starts sending it.
 */
function withPreflight(orgs: Org[], clients: Client[]): Org[] {
  const bySlug = new Map(clients.map((client) => [client.slug, client]));
  return orgs.map((org) => ({
    ...org,
    brands: org.brands.map((brand) => {
      const preflight = brand.preflight ?? bySlug.get(brand.slug)?.preflight;
      return preflight ? { ...brand, preflight } : brand;
    }),
  }));
}

/**
 * The org grouping, preferring the engine's own and falling back to deriving it from the
 * client list. One function, so the mount path and the refresh path can never disagree about
 * what an org is.
 */
async function fetchOrgs(signal?: AbortSignal): Promise<OrgsResponse> {
  // Both, always: /api/orgs owns the grouping and /api/clients owns preflight, so the honest
  // picture needs each of them. They are two cheap reads of the same directory scan.
  const [orgsResult, clientsResult] = await Promise.allSettled([
    api.orgs(signal),
    api.clients(signal),
  ]);

  if (orgsResult.status === "fulfilled") {
    const clients =
      clientsResult.status === "fulfilled" ? clientsResult.value.clients : [];
    return {
      orgs: withPreflight(sortOrgs(orgsResult.value.orgs), clients),
    };
  }

  // 404 means this engine build has no /api/orgs yet. Every client is then its own
  // single-brand org, which is what deriveOrgs builds. Any OTHER status is a real refusal and
  // has to reach the operator verbatim.
  const cause = orgsResult.reason;
  if (!(cause instanceof ApiError) || cause.status !== 404) {
    throw cause;
  }

  if (clientsResult.status !== "fulfilled") {
    throw clientsResult.reason;
  }

  const data: ClientsResponse = clientsResult.value;
  return { orgs: deriveOrgs(data.clients) };
}

export function OrgsProvider({ children }: { children: React.ReactNode }) {
  const [orgs, setOrgs] = React.useState<Org[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  const apply = React.useCallback((data: OrgsResponse) => {
    setOrgs(sortOrgs(data.orgs));
    setError(null);
    setLoading(false);
  }, []);

  const applyError = React.useCallback((cause: unknown) => {
    // The shell must render with the engine down, so a failure parks an honest error rather
    // than throwing into the tree.
    setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    setOrgs([]);
    setLoading(false);
  }, []);

  // The engine is an external system, so this effect subscribes to it and writes state only
  // from the settled callbacks. `loading` starts true, so nothing is set synchronously.
  React.useEffect(() => {
    const controller = new AbortController();
    fetchOrgs(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          apply(data);
        }
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        applyError(cause);
      },
    );
    return () => controller.abort();
  }, [apply, applyError]);

  /** Called from event handlers only, so flipping the spinner on here is safe. */
  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      apply(await fetchOrgs());
    } catch (cause) {
      applyError(cause);
    }
  }, [apply, applyError]);

  const value = React.useMemo<OrgsState>(() => {
    const brands = orgs.flatMap((org) => org.brands);
    return {
      orgs,
      brands,
      loading,
      error,
      refresh,
      findOrg: (slug) => orgs.find((org) => org.slug === slug) ?? null,
      findBrand: (slug) => {
        for (const org of orgs) {
          const brand = org.brands.find((b) => b.slug === slug);
          if (brand) {
            return { org, brand };
          }
        }
        return null;
      },
    };
  }, [orgs, loading, error, refresh]);

  return <OrgsContext.Provider value={value}>{children}</OrgsContext.Provider>;
}

export function useOrgs(): OrgsState {
  const ctx = React.useContext(OrgsContext);
  if (!ctx) {
    throw new Error("useOrgs must be used inside OrgsProvider");
  }
  return ctx;
}

/* Route helpers. The route is the authority for the active org and brand, so these build
   hrefs and nothing else stores them. */

export function orgHref(orgSlug: string): string {
  return `/admin/org/${orgSlug}`;
}

export function brandHref(orgSlug: string, brandSlug: string, section = ""): string {
  return `/admin/org/${orgSlug}/${brandSlug}${section}`;
}

/**
 * The canonical URL of a brand computed from the brand ALONE. A brand's org slug is its
 * organisation slug, or its own slug when it stands alone, matching deriveOrgs exactly. This is
 * how a freshly created brand is routed to WITHOUT re-reading the orgs list first: findBrand
 * closes over the pre-refresh orgs, so `await refresh(); findBrand(slug)` still misses the brand
 * that was just made and falls back to "/". The created record already carries its organisation,
 * so the address is knowable straight away.
 */
export function brandLocationHref(brand: Client, section = ""): string {
  return brandHref(brand.organisation?.slug ?? brand.slug, brand.slug, section);
}

/**
 * Add a brand, prefilled into an existing org.
 *
 * This is load bearing. A single-brand org now redirects past its own org page, and that page
 * is where Add brand used to live, so without a route to this from inside a brand a
 * single-brand org would be trapped at one brand forever.
 *
 * It carries the org NAME rather than its slug because /new takes a name: the engine slugifies
 * and matches, so an existing name joins that org instead of creating a near duplicate.
 */
export function addBrandHref(orgName: string): string {
  return `/admin/new?org=${encodeURIComponent(orgName)}`;
}

/**
 * Remembers the last org for the / redirect ONLY. Nothing else reads it, because anything
 * deeper than an org is in the URL where it belongs.
 */
export function readLastOrg(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

export function writeLastOrg(slug: string): void {
  try {
    window.localStorage.setItem(LAST_ORG_KEY, slug);
  } catch {
    // Private browsing can refuse storage. Losing the redirect target is survivable and
    // only costs the operator one click on the org switcher. Crashing the shell is not.
  }
}

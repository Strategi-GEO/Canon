// The CLIENT portal's routing rules for the one app. The admin interface lives under
// /admin/*; the client portal owns the rest of the root. The URL a client sees depends on
// how many brands their organisation has, and that is the whole of the scheme here:
//
//   single-brand org -> /{brand}                    (the common case, clean and short)
//   multi-brand org  -> /{org} chooser, /{org}/{brand}
//
// Because /{brand} and /{org} are both a single dynamic segment, the first segment cannot be
// classified as an org or a brand from the string alone: it takes the caller's own org list
// (RLS-scoped, so it only ever holds their orgs). resolveClientRoute() is that one resolver,
// used by the client catch-all page to render and by the shell to light the active nav, so
// the two can never disagree about where the caller is.
import { ChartColumnIncreasing, FileText, FolderOpen, LayoutDashboard, Map as MapIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  /** The path suffix under the brand base. Empty string is the brand overview. */
  section: string;
  label: string;
  icon: LucideIcon;
};

/**
 * The CLIENT's brand nav: the admin dashboard's shape with the operator-only rows absent.
 * There is deliberately no Create, no Repurpose and no Settings here: a client reads and
 * answers; the plan and the pipeline are the team's.
 *
 * RESOURCES IS THE ONE ROW THAT CROSSED BACK, and it crossed because the ownership runs the
 * other way from every other row. The rest of this nav shows work the team produced and the
 * client receives, so an operator affordance on it would be the client editing the team's
 * output. Resources is the client's own fact base: the documents they hand us, which the
 * researcher reads before any external search. Only the client uploads and manages them, and
 * an admin can read them and nothing more, so the row belongs here in a way Create never did.
 * It sits last because it is the only row that is not a thing to read.
 */
export const BRAND_NAV: NavItem[] = [
  { section: "", label: "Overview", icon: LayoutDashboard },
  { section: "/roadmap", label: "Content Roadmap", icon: MapIcon },
  { section: "/blogs", label: "Blogs", icon: FileText },
  // The monthly performance report, but only the versions the team has shared. Same section
  // word and icon as the admin dashboard's Reports row, so a client reading over an operator's
  // shoulder sees the same tab.
  { section: "/reports", label: "Reports", icon: ChartColumnIncreasing },
  // Same section, label and icon as the admin dashboard's own Resources row
  // (components/shell/nav.ts), because it is the same files under both roofs and a client
  // reading over an operator's shoulder should not have to translate.
  { section: "/resources", label: "Resources", icon: FolderOpen },
];

/** Top-level segments the client space must never treat as an org or brand slug. */
const RESERVED = new Set(["admin", "login", "api", "_next", "favicon.ico"]);
/**
 * Section keywords that disambiguate "brand + section" from "org + brand". EVERY nav section
 * must appear here: the resolver reads /{a}/{b} as an org and a brand unless b is a known
 * section word, so a section missing from this set resolves to not-found for a multi-brand
 * org and, worse, silently to the brand overview for a single-brand one.
 */
const SECTIONS = new Set(["blogs", "roadmap", "reports", "resources"]);

export type OrgLite = {
  slug: string;
  name: string;
  brands: { slug: string; name: string }[];
};

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function isSingle(org: OrgLite): boolean {
  return org.brands.length === 1;
}

// ---------------------------------------------------------------------------
// Href builders. `singleBrand` decides the shape, so callers pass what they already know
// from the org list (portal-context attaches it to every brand, and the blog card carries
// it), and no builder needs to re-read the whole org list to place one link.
// ---------------------------------------------------------------------------

/** The multi-brand org chooser, /{org}. Only reached when an org has more than one brand. */
export function orgHref(orgSlug: string): string {
  return `/${enc(orgSlug)}`;
}

export function brandHref(
  orgSlug: string,
  brandSlug: string,
  singleBrand: boolean,
  section = "",
): string {
  const base = singleBrand ? `/${enc(brandSlug)}` : `/${enc(orgSlug)}/${enc(brandSlug)}`;
  return `${base}${section}`;
}

export function blogHref(
  orgSlug: string,
  brandSlug: string,
  singleBrand: boolean,
  topic: string,
): string {
  return `${brandHref(orgSlug, brandSlug, singleBrand, "/blogs")}/${enc(topic)}`;
}

/**
 * Where home is for THIS login, resolved from the caller's own orgs.
 *
 * "/" is not a wrong address, it is a slow and blank one: the site root is a signpost that
 * reads /api/me and then /api/overview before it can decide where a caller belongs, so a
 * link to it from inside the portal spends two requests and a spinner reaching a page whose
 * address the shell is already holding. The org list here is the very list the signpost
 * would fetch. A login spanning several orgs has no single home to name, so it keeps the
 * signpost and lets that page choose, rather than this function guessing at one.
 */
export function homeHref(orgs: OrgLite[]): string {
  if (orgs.length !== 1) {
    return "/";
  }
  const org = orgs[0];
  return isSingle(org) ? brandHref(org.slug, org.brands[0].slug, true) : orgHref(org.slug);
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

export type ClientRoute =
  | { kind: "org-chooser"; org: string }
  | { kind: "brand"; org: string; brand: string; section: string; topic: string | null }
  | { kind: "redirect"; to: string }
  | { kind: "not-found" };

function index(orgs: OrgLite[]) {
  const orgBySlug = new Map<string, OrgLite>();
  const brandToOrg = new Map<string, OrgLite>();
  for (const org of orgs) {
    orgBySlug.set(org.slug, org);
    for (const brand of org.brands) {
      brandToOrg.set(brand.slug, org);
    }
  }
  return { orgBySlug, brandToOrg };
}

function hasBrand(org: OrgLite, brandSlug: string): boolean {
  return org.brands.some((brand) => brand.slug === brandSlug);
}

/**
 * Classify a client-space pathname against the caller's own orgs. Returns where to render,
 * where to redirect (a non-canonical URL for a reachable brand), or not-found (an unknown or
 * out-of-scope slug, which is deliberately indistinguishable so it cannot be an existence
 * oracle for another org's work).
 */
export function resolveClientRoute(pathname: string, orgs: OrgLite[]): ClientRoute {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0 || RESERVED.has(parts[0])) {
    return { kind: "not-found" };
  }
  const { orgBySlug, brandToOrg } = index(orgs);

  if (parts.length === 1) {
    const [a] = parts;
    const org = orgBySlug.get(a);
    if (org) {
      if (isSingle(org)) {
        const only = org.brands[0].slug;
        return a === only
          ? { kind: "brand", org: org.slug, brand: only, section: "", topic: null }
          : { kind: "redirect", to: `/${enc(only)}` };
      }
      return { kind: "org-chooser", org: org.slug };
    }
    const owner = brandToOrg.get(a);
    if (owner) {
      return isSingle(owner)
        ? { kind: "brand", org: owner.slug, brand: a, section: "", topic: null }
        : { kind: "redirect", to: `/${enc(owner.slug)}/${enc(a)}` };
    }
    return { kind: "not-found" };
  }

  if (parts.length === 2) {
    const [a, b] = parts;
    if (SECTIONS.has(b)) {
      const owner = brandToOrg.get(a);
      if (!owner) return { kind: "not-found" };
      if (!isSingle(owner)) return { kind: "redirect", to: `/${enc(owner.slug)}/${enc(a)}/${b}` };
      return { kind: "brand", org: owner.slug, brand: a, section: `/${b}`, topic: null };
    }
    const org = orgBySlug.get(a);
    if (!org || !hasBrand(org, b)) return { kind: "not-found" };
    if (isSingle(org)) return { kind: "redirect", to: `/${enc(b)}` };
    return { kind: "brand", org: a, brand: b, section: "", topic: null };
  }

  if (parts.length === 3) {
    const [a, b, c] = parts;
    if (SECTIONS.has(b)) {
      if (b !== "blogs") return { kind: "not-found" };
      const owner = brandToOrg.get(a);
      if (!owner) return { kind: "not-found" };
      if (!isSingle(owner)) return { kind: "redirect", to: `/${enc(owner.slug)}/${enc(a)}/blogs/${enc(c)}` };
      return { kind: "brand", org: owner.slug, brand: a, section: "/blogs", topic: c };
    }
    if (!SECTIONS.has(c)) return { kind: "not-found" };
    const org = orgBySlug.get(a);
    if (!org || !hasBrand(org, b)) return { kind: "not-found" };
    if (isSingle(org)) return { kind: "redirect", to: `/${enc(b)}/${c}` };
    return { kind: "brand", org: a, brand: b, section: `/${c}`, topic: null };
  }

  if (parts.length === 4) {
    const [a, b, c, d] = parts;
    if (c !== "blogs") return { kind: "not-found" };
    const org = orgBySlug.get(a);
    if (!org || !hasBrand(org, b)) return { kind: "not-found" };
    if (isSingle(org)) return { kind: "redirect", to: `/${enc(b)}/blogs/${enc(d)}` };
    return { kind: "brand", org: a, brand: b, section: "/blogs", topic: d };
  }

  return { kind: "not-found" };
}

export function isActiveSection(current: string, section: string): boolean {
  if (section === "") {
    return current === "";
  }
  return current === section || current.startsWith(`${section}/`);
}

export function pageTitle(pathname: string, orgs: OrgLite[]): string {
  const route = resolveClientRoute(pathname, orgs);
  if (route.kind === "org-chooser") {
    return "Your brands";
  }
  if (route.kind !== "brand") {
    return "Client Portal";
  }
  if (route.section.startsWith("/blogs")) {
    return "Blogs";
  }
  const match = BRAND_NAV.find((item) => isActiveSection(route.section, item.section));
  return match?.label ?? "Client Portal";
}

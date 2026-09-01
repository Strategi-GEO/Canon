// Map is aliased on principle: the bare name shadows the JS Map constructor, and a file that
// later builds one would break in a way that reads as a typing error rather than an import.
import {
  AtSign,
  BriefcaseBusiness,
  ChartColumnIncreasing,
  Cloud,
  Feather,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Map as MapIcon,
  Recycle,
  Settings,
  Telescope,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Org } from "@/types";

export type NavItem = {
  /** The path suffix under /org/<org>/<brand>. Empty string is the brand overview. */
  section: string;
  label: string;
  icon: LucideIcon;
};

/**
 * The nav is BRAND scoped, and there is nothing above it but the org switcher.
 *
 * There is no global Dashboard, no global Create and no global Blogs, because each of those
 * needs a brand to mean anything: a blog written without a brand has no canonical facts, no
 * roadmap to obey. Scoping the nav to a brand makes that structural
 * rather than a rule someone has to remember.
 */
export const BRAND_NAV: NavItem[] = [
  { section: "", label: "Overview", icon: LayoutDashboard },
  // Before Blogs, because it comes before it: the roadmap is the input the New tab picks from,
  // and with no roadmap that tab has nothing to offer but a link back to here.
  { section: "/roadmap", label: "Content Roadmap", icon: MapIcon },
  // ONE ENTRY, NOT TWO. Create Blogs was its own section and is now the Blogs page's New tab:
  // picking a topic and reading what came of it were two nav rows describing one pipeline, and an
  // operator moved between them constantly. /create still resolves, as a redirect to ?tab=new,
  // because nine places link to it and one of those links carries a retry.
  { section: "/blogs", label: "Blogs", icon: FileText },
  // Distribution channels for POSTED blogs (the `published` state). Each shows the Blogs table
  // filtered to blogs already pushed out, so they sit right after Blogs and before Repurpose.
  { section: "/linkedin", label: "LinkedIn", icon: BriefcaseBusiness },
  { section: "/medium", label: "Medium", icon: Feather },
  // Bluesky and X are the same tab as the two above, built from the same ChannelLibrary, and
  // differ in exactly one respect: a CMS publish never auto-generates them (AUTO_CHANNELS in
  // server/repurpose.py). The operator ticks blogs and presses Generate. That difference is
  // invisible from here, which is the point: they are ordinary channels everywhere but the hook.
  //
  // Icons are metaphors, not logos, matching the two rows above (a briefcase is not LinkedIn's
  // mark either). Cloud reads as blue sky; the at-sign is the microblog handle. lucide's `X` is
  // the CLOSE glyph and would read as a dismiss button in a nav, so it is deliberately not used.
  { section: "/bluesky", label: "Bluesky", icon: Cloud },
  { section: "/x", label: "X", icon: AtSign },
  // After Blogs because it consumes them: repurposing turns shipped blogs into other
  // formats, so it sits downstream of the library it will draw from.
  { section: "/repurpose", label: "Repurpose", icon: Recycle },
  // The monthly performance report: AI visibility, backlinks and referring domains over time.
  // It reads the outcome of the work the rows above produce, so it sits after them.
  { section: "/reports", label: "Reports", icon: ChartColumnIncreasing },
  // The monthly Analysis report: the deep six-tool GEO + SEO visibility read (prompt matrix,
  // rankings, engagement, outcomes). Kept separate from Reports on purpose. Sits beside it.
  { section: "/analysis", label: "Analysis", icon: Telescope },
  { section: "/resources", label: "Resources", icon: FolderOpen },
  { section: "/settings", label: "Settings", icon: Settings },
];

export type BrandRouteParts = {
  org: string;
  brand: string;
  /** The section suffix, "" on the overview. */
  section: string;
};

/**
 * Reads the active org and brand out of the path. The route is the authority for both, so
 * this is the only place either is derived, and no stored copy can contradict it.
 */
export function parseBrandPath(pathname: string): BrandRouteParts | null {
  const match = /^\/admin\/org\/([^/]+)\/([^/]+)(\/[^/]*)?/.exec(pathname);
  if (!match) {
    return null;
  }
  return { org: match[1], brand: match[2], section: match[3] ?? "" };
}

/** The org slug in the path, on an org home as well as anywhere inside a brand. */
export function parseOrgPath(pathname: string): string | null {
  const match = /^\/admin\/org\/([^/]+)/.exec(pathname);
  return match ? match[1] : null;
}

/**
 * The organisation a route is standing in, resolved against the list that actually exists.
 *
 * The PATH is the authority wherever it names one. /admin/new?org=<name> is the one route that
 * names an org WITHOUT one, because adding a brand happens off the org's own path, and the query
 * is then the only thing saying which org the brand is joining. Without this fallback the sidebar
 * and the switcher read that route as "no org" and reset to the org list mid flow, so the operator
 * fills in a brand form with no sight of the organisation they are filling it in for.
 *
 * ?org= carries the NAME rather than a slug, matching addBrandHref and the engine's own matching,
 * so the fallback compares names case insensitively. A name no org answers to is the org-first
 * flow creating one, and null is the honest answer there: there are no brands to show yet.
 */
export function resolveActiveOrg(
  orgs: Org[],
  pathname: string,
  joiningOrg: string,
): Org | null {
  const slug = parseOrgPath(pathname);
  if (slug !== null) {
    return orgs.find((org) => org.slug === slug) ?? null;
  }
  const wanted = joiningOrg.trim().toLowerCase();
  if (wanted === "") {
    return null;
  }
  return orgs.find((org) => org.name.toLowerCase() === wanted) ?? null;
}

export function isActiveSection(current: string, section: string): boolean {
  // The overview owns the bare brand path only. Prefix matching would light Overview on
  // every page, since every brand path starts with the brand path.
  if (section === "") {
    return current === "";
  }
  return current === section || current.startsWith(`${section}/`);
}

export function pageTitle(pathname: string): string {
  if (pathname === "/admin/new") {
    return "Add organisation";
  }
  const parts = parseBrandPath(pathname);
  if (!parts) {
    return "Strategi Canon";
  }
  const match = BRAND_NAV.find((item) => isActiveSection(parts.section, item.section));
  return match?.label ?? "Strategi Canon";
}

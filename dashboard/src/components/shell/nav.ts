// Map is aliased on principle: the bare name shadows the JS Map constructor, and a file that
// later builds one would break in a way that reads as a typing error rather than an import.
import {
  FileText,
  FolderOpen,
  LayoutDashboard,
  Map as MapIcon,
  PenLine,
  Recycle,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

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
  // Before Create Blogs, because it comes before it: the roadmap is the input Create Blogs
  // picks from, and with no roadmap that page has nothing to offer but a link back to here.
  { section: "/roadmap", label: "Content Roadmap", icon: MapIcon },
  { section: "/create", label: "Create Blogs", icon: PenLine },
  { section: "/blogs", label: "Blogs", icon: FileText },
  // After Blogs because it consumes them: repurposing turns shipped blogs into other
  // formats, so it sits downstream of the library it will draw from.
  { section: "/repurpose", label: "Repurpose", icon: Recycle },
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
    return "Add client";
  }
  const parts = parseBrandPath(pathname);
  if (!parts) {
    return "Strategi Canon";
  }
  const match = BRAND_NAV.find((item) => isActiveSection(parts.section, item.section));
  return match?.label ?? "Strategi Canon";
}

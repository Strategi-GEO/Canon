"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { BRAND_NAV, isActiveSection, parseBrandPath, parseOrgPath } from "@/components/shell/nav";
import { useOrgs } from "@/lib/orgs-context";

/** The fallback for a route with nothing better to say. Also the app's name. */
const APP_TITLE = "Strategi Canon";

/**
 * Per route tab titles, written imperatively, and the ONLY thing that sets document.title.
 *
 * Next resolves `metadata` and `generateMetadata` on the SERVER, before the page renders, so
 * both exports are Server Component only. Every route here is a client component that resolves
 * its brand from a browser side fetch, so the name this title needs does not exist at the
 * moment Next wants the metadata. Writing document.title from an effect is the remaining
 * honest route: it synchronises with an external system, which is what effects are for.
 *
 * The root layout deliberately exports NO title. It used to, and Next re-committed that static
 * string on every client navigation and every late Suspense resolution, so the two fought and
 * whichever landed last won: measured, "Add client" and "Overview / Demo" reverted within
 * milliseconds while a plain page load kept the right title. One owner, no race.
 *
 * Section first, brand second: a browser truncates a tab at roughly twenty characters, so the
 * part that differs between five open tabs of one brand has to lead.
 */
export function DocumentTitle() {
  // useSearchParams suspends, and an unwrapped read would opt every route into client
  // rendering. The boundary keeps that cost at this one leaf, which renders nothing anyway.
  return (
    <React.Suspense fallback={null}>
      <TitleWriter />
    </React.Suspense>
  );
}

function TitleWriter() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { findOrg, findBrand, loading } = useOrgs();

  const title = resolveTitle(
    pathname,
    searchParams.get("org")?.trim() ?? "",
    loading,
    findOrg,
    findBrand,
  );

  React.useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}

type FindOrg = ReturnType<typeof useOrgs>["findOrg"];
type FindBrand = ReturnType<typeof useOrgs>["findBrand"];

function resolveTitle(
  pathname: string,
  joiningOrg: string,
  loading: boolean,
  findOrg: FindOrg,
  findBrand: FindBrand,
): string {
  if (pathname === "/new") {
    // /new is two flows behind one path, and ?org= is the only thing telling them apart. Two
    // tabs both saying "Add client" would hide which one is adding a brand, and to where.
    return joiningOrg === "" ? "Add client" : `Add brand to ${joiningOrg}`;
  }

  const parts = parseBrandPath(pathname);
  if (parts) {
    const located = findBrand(parts.brand);
    if (!located) {
      // A brand the engine has not listed YET and one it will never list look identical until
      // the list settles, so the tab stays neutral rather than accusing a real brand of not
      // existing for the second the fetch takes.
      return loading ? APP_TITLE : "No such brand";
    }
    const section = BRAND_NAV.find((item) => isActiveSection(parts.section, item.section));
    return `${section?.label ?? "Overview"} / ${located.brand.name}`;
  }

  const orgSlug = parseOrgPath(pathname);
  if (orgSlug) {
    const org = findOrg(orgSlug);
    if (!org) {
      return loading ? APP_TITLE : "No such organisation";
    }
    // A single-brand org redirects to its brand, so this titles the portfolio only. The brand
    // route above renames the tab the moment that redirect lands.
    return org.name;
  }

  return APP_TITLE;
}

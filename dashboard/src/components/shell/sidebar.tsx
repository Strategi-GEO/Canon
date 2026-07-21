"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Box, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { BRAND_NAV, isActiveSection, parseBrandPath, parseOrgPath } from "@/components/shell/nav";
import { OrgSwitcher } from "@/components/shell/org-switcher";
import { BrandSwitcher } from "@/components/shell/brand-switcher";
import { AddOrganisationDialog } from "@/components/clients/add-organisation-dialog";
import { addBrandHref, brandHref, orgHref, useOrgs } from "@/lib/orgs-context";
import { cn } from "@/lib/utils";
import type { Org } from "@/types";

/**
 * A dialog trigger dressed as a nav row, so "Add organisation" and "Add brand" read as the same
 * kind of control even though one opens a dialog and the other is a Link. The class list is the
 * inactive NavRow above, kept in step by hand because a button cannot BE a NavRow (that is a
 * Link), and a two-line duplication is cheaper than a NavRow that has to branch on its element.
 */
const NAV_ROW_BUTTON =
  "relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function Wordmark() {
  return (
    <Link
      href="/admin"
      className="font-wordmark block rounded-sm text-[1.0625rem] leading-tight tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="font-normal">Strategi</span>{" "}
      <span className="font-bold">Canon</span>
    </Link>
  );
}

/** One row of sidebar nav. Shared so every state below looks like the same control. */
function NavRow({
  href,
  active,
  onNavigate,
  icon: Icon,
  children,
  indent = false,
}: {
  href: string;
  active?: boolean;
  onNavigate?: () => void;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  children: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        indent && "pl-8",
        active
          ? "bg-primary/8 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
        />
      ) : null}
      {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

/**
 * The brand's sections in the URL, plus a brand switcher when there is something to
 * switch between.
 */
function BrandNav({
  parts,
  org,
  onNavigate,
}: {
  parts: { org: string; brand: string; section: string };
  org: Org | null;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* Only when the org holds several brands. A switcher with one option is a control that
          cannot do anything: it costs a row of sidebar and a moment of the operator's
          attention to discover that it does nothing. */}
      {org && org.brands.length > 1 ? (
        <BrandSwitcher
          org={org}
          activeBrandSlug={parts.brand}
          section={parts.section}
          onNavigate={onNavigate}
        />
      ) : null}

      <nav aria-label="Brand" className="flex flex-col gap-0.5">
        {BRAND_NAV.map((item) => (
          <NavRow
            key={item.section || "overview"}
            href={brandHref(parts.org, parts.brand, item.section)}
            active={isActiveSection(parts.section, item.section)}
            onNavigate={onNavigate}
            icon={item.icon}
          >
            {item.label}
          </NavRow>
        ))}
      </nav>
    </div>
  );
}

/**
 * Standing on a multi-brand org, the sidebar IS the chooser. A dead switcher over blank space
 * was the defect: with no brand in the URL there was nothing to show, so the column emptied.
 * The brands themselves are the nav here, because picking one is the only thing this page is
 * for.
 */
function OrgBrandNav({ org, onNavigate }: { org: Org; onNavigate?: () => void }) {
  return (
    <nav aria-label="Brands" className="flex flex-col gap-0.5">
      <p className="px-2.5 pt-1 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        Brands
      </p>
      {org.brands.map((brand) => (
        <NavRow
          key={brand.slug}
          href={brandHref(org.slug, brand.slug)}
          onNavigate={onNavigate}
          icon={Box}
        >
          {brand.name}
        </NavRow>
      ))}
      <NavRow href={addBrandHref(org.name)} onNavigate={onNavigate} icon={Plus}>
        Add brand
      </NavRow>
    </nav>
  );
}

/**
 * Off any org entirely: /new, a route that matched nothing, or the instant before / resolves.
 * The orgs are the only nav that means anything here, and an empty column would be worse.
 */
function OrgListNav({ orgs, onNavigate }: { orgs: Org[]; onNavigate?: () => void }) {
  const router = useRouter();
  const { refresh, findBrand } = useOrgs();

  if (orgs.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Organisations" className="flex flex-col gap-0.5">
      <p className="px-2.5 pt-1 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        Organisations
      </p>
      {orgs.map((org) => (
        <NavRow key={org.slug} href={orgHref(org.slug)} onNavigate={onNavigate} icon={Box}>
          {org.name}
        </NavRow>
      ))}
      {/* The org-level twin of OrgBrandNav's "Add brand" row. Returns null on the hosted,
          read-only build, so the row simply does not appear there. */}
      <AddOrganisationDialog
        trigger={
          <button type="button" className={NAV_ROW_BUTTON}>
            <Plus className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Add organisation</span>
          </button>
        }
        onCreated={async (brand) => {
          onNavigate?.();
          await refresh();
          const located = findBrand(brand.slug);
          router.push(located ? brandHref(located.org.slug, located.brand.slug) : "/");
        }}
      />
    </nav>
  );
}

/** Shaped like the nav it stands in for, so the column never jumps when the list lands. */
function NavSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 px-2.5" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/**
 * THE SIDEBAR IS NEVER EMPTY. That is an invariant, not a bug fix.
 *
 * Every state resolves to real nav: a brand's sections inside a brand, the brand list on an
 * org, the org list anywhere else, and skeleton rows while the hierarchy loads. There is no
 * branch that falls through to nothing, because the one that used to is what put an operator
 * in front of a blank column with no way out but the browser Back button.
 */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { orgs, loading, findOrg } = useOrgs();

  if (loading) {
    return <NavSkeleton />;
  }

  const parts = parseBrandPath(pathname);
  if (parts) {
    return <BrandNav parts={parts} org={findOrg(parts.org)} onNavigate={onNavigate} />;
  }

  const orgSlug = parseOrgPath(pathname);
  const org = orgSlug ? findOrg(orgSlug) : null;
  if (org) {
    return <OrgBrandNav org={org} onNavigate={onNavigate} />;
  }

  return <OrgListNav orgs={orgs} onNavigate={onNavigate} />;
}

/** Shared by the fixed desktop rail and the mobile Sheet, so the two never drift apart. */
export function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-5 pb-4">
        <Wordmark />
      </div>
      <div className="px-2.5 pb-3">
        <OrgSwitcher onNavigate={onNavigate} />
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <SidebarNav onNavigate={onNavigate} />
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-sidebar lg:block">
      <SidebarBody />
    </aside>
  );
}

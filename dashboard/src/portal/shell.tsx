"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Box, Check, ChevronsUpDown, Loader2, LogOut, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BRAND_NAV,
  brandHref,
  isActiveSection,
  orgHref,
  pageTitle,
  resolveClientRoute,
} from "@/portal/nav";
import { PortalDataProvider, usePortal } from "@/portal/portal-context";
import {
  getSession,
  signOut,
  startSessionRefreshTimer,
  subscribeSession,
} from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * The portal shell, mirroring the admin dashboard's frame deliberately: the same fixed
 * w-60 sidebar, the same NavRow idiom with the active rail, the same sticky topbar with
 * the mobile Sheet. A client and an operator are using the SAME PRODUCT; what differs is
 * what stands in the frame, never the frame. The client's brand nav is the admin's minus
 * every operator-only row, and there is no org switcher because a login IS its org.
 */

export function Wordmark() {
  return (
    <Link
      href="/"
      className="block rounded-sm leading-tight tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="text-[1.0625rem]">
        <span className="font-normal">Strategi</span>{" "}
        <span className="font-bold">Canon</span>
      </span>
      <span className="block text-[0.625rem] font-medium tracking-[0.14em] text-muted-foreground uppercase">
        Client Portal
      </span>
    </Link>
  );
}

/** One row of sidebar nav, verbatim from the admin dashboard so the two cannot drift. */
function NavRow({
  href,
  active,
  onNavigate,
  icon: Icon,
  children,
}: {
  href: string;
  active?: boolean;
  onNavigate?: () => void;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "bg-primary/8 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {active ? (
        <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
      ) : null}
      {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

/**
 * The brand picker above the brand nav, the admin dashboard's BrandSwitcher rebuilt for
 * the portal: shown only when the login spans several brands, and it keeps the current
 * section when it switches, so a client comparing two brands' blogs stays on Blogs.
 */
function BrandSwitcher({
  brands,
  activeBrandSlug,
  section,
  isSingleBrand,
  onNavigate,
}: {
  brands: { slug: string; name: string; org: string }[];
  activeBrandSlug: string;
  section: string;
  isSingleBrand: (orgSlug: string) => boolean;
  onNavigate?: () => void;
}) {
  const active = brands.find((brand) => brand.slug === activeBrandSlug);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
          "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "aria-expanded:bg-muted",
        )}
        aria-label="Switch brand"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            Brand
          </span>
          <span className="block truncate text-sm font-medium text-foreground">
            {active?.name ?? activeBrandSlug}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Your brands</DropdownMenuLabel>
        {brands.map((brand) => (
          <DropdownMenuItem key={brand.slug} asChild>
            <Link
              href={brandHref(brand.org, brand.slug, isSingleBrand(brand.org), section)}
              onClick={onNavigate}
              className="gap-2"
            >
              <Check
                className={cn(
                  "size-4 shrink-0",
                  brand.slug === activeBrandSlug ? "text-primary" : "opacity-0",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{brand.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavSkeleton() {
  return (
    <div className="flex flex-col gap-1.5 px-2.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/**
 * THE SIDEBAR IS NEVER EMPTY, the same invariant the admin sidebar holds. Inside a brand:
 * that brand's sections (with a way back to the brand list when there are several). On the
 * brand list or anywhere else: the brands themselves ARE the nav.
 */
function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { orgs, brands, loading, isSingleBrand } = usePortal();

  if (loading) {
    return <NavSkeleton />;
  }

  const route = resolveClientRoute(pathname, orgs);
  const parts = route.kind === "brand" ? route : null;
  const active = parts
    ? brands.find((brand) => brand.slug === parts.brand && brand.org === parts.org)
    : undefined;

  if (parts && active) {
    // Blog detail paths keep the Blogs section under the switcher, so switching brands
    // from inside an article lands on the other brand's library, never a missing topic.
    const section = parts.section.startsWith("/blogs") ? "/blogs" : parts.section;
    // The switcher lists the brands of THIS org only, so a multi-org login (an operator
    // previewing) never mixes another org's brands into the picker.
    const orgBrands = brands.filter((brand) => brand.org === parts.org);
    const multiBrand = orgBrands.length > 1;
    return (
      <div className="flex flex-col gap-2">
        {multiBrand ? (
          <BrandSwitcher
            brands={orgBrands}
            activeBrandSlug={parts.brand}
            section={section}
            isSingleBrand={isSingleBrand}
            onNavigate={onNavigate}
          />
        ) : (
          <p className="truncate px-2.5 pt-1 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            {active.name}
          </p>
        )}
        <nav aria-label="Brand" className="flex flex-col gap-0.5">
          {BRAND_NAV.map((item) => (
            <NavRow
              key={item.section || "overview"}
              href={brandHref(parts.org, parts.brand, isSingleBrand(parts.org), item.section)}
              active={isActiveSection(parts.section, item.section)}
              onNavigate={onNavigate}
              icon={item.icon}
            >
              {item.label}
            </NavRow>
          ))}
        </nav>
        {multiBrand ? (
          <nav aria-label="Back" className="flex flex-col gap-0.5 border-t pt-2">
            <NavRow href={orgHref(parts.org)} onNavigate={onNavigate} icon={ArrowLeft}>
              All brands
            </NavRow>
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <nav aria-label="Brands" className="flex flex-col gap-0.5">
      <p className="px-2.5 pt-1 pb-1.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        Brands
      </p>
      {brands.map((brand) => (
        <NavRow
          key={`${brand.org}/${brand.slug}`}
          href={brandHref(brand.org, brand.slug, isSingleBrand(brand.org))}
          onNavigate={onNavigate}
          icon={Box}
        >
          {brand.name}
        </NavRow>
      ))}
    </nav>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-5 pb-4">
        <Wordmark />
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <SidebarNav onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-card lg:block">
      <SidebarBody />
    </aside>
  );
}

function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState<string | null>(null);
  const { orgs, brands } = usePortal();

  React.useEffect(() => {
    const read = () => setEmail(getSession()?.user.email ?? null);
    read();
    return subscribeSession(read);
  }, []);

  const route = resolveClientRoute(pathname, orgs);
  const parts = route.kind === "brand" ? route : null;
  const brand = parts
    ? (brands.find((entry) => entry.slug === parts.brand && entry.org === parts.org) ?? null)
    : null;
  const org = brand ? (orgs.find((entry) => entry.slug === brand.org) ?? null) : null;

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
        {pageTitle(pathname, orgs)}
      </h1>

      <div className="flex items-center gap-3">
        {brand !== null ? (
          <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            {org !== null && org.brands.length > 1 ? (
              <>
                <span className="max-w-32 truncate">{org.name}</span>
                <span aria-hidden>/</span>
              </>
            ) : null}
            <span className="max-w-40 truncate text-foreground">{brand.name}</span>
          </span>
        ) : null}
        <div className="flex items-center gap-1.5">
          {email !== null ? (
            <span className="hidden max-w-44 truncate text-xs text-muted-foreground md:inline" title={email}>
              {email}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              signOut();
              router.replace("/login");
            }}
          >
            <LogOut aria-hidden />
          </Button>
        </div>
      </div>
    </header>
  );
}

function useAuthed(): boolean | null {
  const [authed, setAuthed] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    const read = () => setAuthed(getSession() !== null);
    read();
    return subscribeSession(read);
  }, []);
  return authed;
}

export function PortalShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const authed = useAuthed();

  React.useEffect(() => {
    if (authed === false) {
      router.replace("/login");
    }
  }, [authed, router]);

  React.useEffect(() => {
    if (authed === true) {
      return startSessionRefreshTimer();
    }
  }, [authed]);

  if (authed !== true) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only" role="status">
          Checking your session
        </span>
      </div>
    );
  }

  return (
    <PortalDataProvider>
      <Sidebar />
      <div className="flex min-h-dvh flex-col lg:pl-60">
        <Topbar />
        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </PortalDataProvider>
  );
}

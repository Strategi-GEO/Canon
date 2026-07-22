"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { AddOrganisationDialog } from "@/components/clients/add-organisation-dialog";
import { addBrandHref, brandHref, brandLocationHref, orgHref, useOrgs } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { parseBrandPath, parseOrgPath } from "@/components/shell/nav";
import { useCommandPalette } from "@/components/shell/command-palette";
import { useModLabel } from "@/lib/use-hotkey";
import { cn } from "@/lib/utils";
import type { Org } from "@/types";

/**
 * Past this many rows the operator is scanning rather than reading, so a filter earns its
 * place. Below it, a search field is one more thing on screen answering a question nobody
 * asked.
 */
const SEARCH_THRESHOLD = 7;

/**
 * Pinned at the top of the sidebar: the org is the widest thing an operator navigates, and
 * everything below it is scoped to whatever is picked here.
 *
 * Brands nest under a multi-brand org so the operator can jump straight to one. That matters
 * because the brand, not the org, is the engine's unit of work: an org owns no canonical
 * facts, so landing on one is never the end of a journey.
 */
export function OrgSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { orgs, loading, error, refresh } = useOrgs();
  const pathname = usePathname();
  const router = useRouter();
  const palette = useCommandPalette();
  const modLabel = useModLabel();
  const [open, setOpen] = React.useState(false);
  // Opened from the popover: the CommandItem closes the popover and flips this, the same
  // shape the palette open below uses, so a Dialog never fights the popover for focus.
  const [addOrgOpen, setAddOrgOpen] = React.useState(false);

  const orgSlug = parseOrgPath(pathname);
  const brandSlug = parseBrandPath(pathname)?.brand ?? null;
  const activeOrg = orgs.find((org) => org.slug === orgSlug) ?? null;

  if (loading) {
    return <Skeleton className="h-12 w-full" />;
  }

  /**
   * Four different situations, four different sentences. "No client yet" used to cover all of
   * them, so standing on /new or on an org slug that does not exist claimed the engine held
   * no clients while this very menu listed three of them directly underneath. An empty list
   * and no selection are not the same fact.
   */
  const label = activeOrg
    ? activeOrg.name
    : error
      ? "Engine unreachable"
      : orgs.length === 0
        ? "No client yet"
        : "Select an organisation";

  const rows = orgs.length + orgs.reduce((total, org) => total + org.brands.length, 0);

  function go(href: string) {
    setOpen(false);
    onNavigate?.();
    router.push(href);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors",
          "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          "aria-expanded:bg-muted",
        )}
        aria-label="Switch organisation"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            Organisation
          </span>
          <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>

      <PopoverContent align="start" side="bottom" className="w-64 p-0">
        {/* Every row's value IS its href, so highlighting a row is enough to warm it. */}
        <Command
          loop
          onValueChange={(value) => {
            if (value.startsWith("/")) {
              router.prefetch(value);
            }
          }}
        >
          {rows >= SEARCH_THRESHOLD ? (
            <CommandInput placeholder="Find an organisation or brand" />
          ) : null}

          <CommandList>
            {orgs.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                {error
                  ? "Cannot reach the engine, so no organisations loaded."
                  : "No clients yet. Add the first one below."}
              </p>
            ) : (
              <>
                <CommandEmpty className="py-4 text-xs text-muted-foreground">
                  Nothing matches that.
                </CommandEmpty>
                <CommandGroup heading="Organisations">
                  {orgs.map((org) => (
                    <OrgRows
                      key={org.slug}
                      org={org}
                      activeOrgSlug={orgSlug}
                      activeBrandSlug={brandSlug}
                      onGo={go}
                    />
                  ))}
                </CommandGroup>
              </>
            )}

            <CommandSeparator />
            <CommandGroup>
              {/*
                Load bearing, not a convenience. A single-brand org redirects past its own org
                page, and that page is where Add brand lived, so without this row a
                single-brand org has no route to a second brand at all: the redirect would
                trap it at one brand forever. It sits in the switcher because the switcher is
                the one control present on every route.
              */}
              {/* Both rows lead to onboarding, an engine write, so the hosted, read-only
                  build lists nothing to add. */}
              {!HOSTED_READONLY && activeOrg ? (
                <CommandItem
                  value={addBrandHref(activeOrg.name)}
                  keywords={["add brand", activeOrg.name]}
                  onSelect={go}
                >
                  <Plus className="text-muted-foreground" aria-hidden />
                  <span className="min-w-0 truncate">Add brand to {activeOrg.name}</span>
                </CommandItem>
              ) : null}
              {/* Opens the org-first dialog rather than routing to a page: adding an org is
                  the same POST /api/clients a brand is, so it need not leave the current
                  screen. Closing the popover before flipping the dialog open keeps the two
                  overlays from contending for focus, exactly as Search everything does below. */}
              {HOSTED_READONLY ? null : (
                <CommandItem
                  value="add-organisation"
                  keywords={["add organisation", "add client", "new organisation", "new brand"]}
                  onSelect={() => {
                    setOpen(false);
                    setAddOrgOpen(true);
                  }}
                >
                  <Plus className="text-muted-foreground" aria-hidden />
                  <span>Add organisation</span>
                </CommandItem>
              )}
              {/* The palette does everything this menu does and reaches sections besides, so
                  the menu is where an operator is most likely to be taught it. Named with the
                  key their own keyboard actually carries. */}
              <CommandItem
                value="command-palette"
                keywords={["search", "jump", "palette"]}
                onSelect={() => {
                  setOpen(false);
                  palette.open();
                }}
              >
                <Search className="text-muted-foreground" aria-hidden />
                <span>Search everything</span>
                <kbd className="machine ml-auto shrink-0 rounded border border-border bg-muted px-1.5 py-px text-[0.6875rem] leading-tight text-muted-foreground">
                  {modLabel}K
                </kbd>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
      </Popover>

      {/* Controlled and trigger-less: the popover item above opens it. onCreated routes to the
          new brand, so the operator lands where the work happens rather than on an org grouping
          that owns no facts. The address comes from the created record itself, so the redirect
          does not wait on the orgs list; refresh only repopulates the nav behind it. */}
      <AddOrganisationDialog
        open={addOrgOpen}
        onOpenChange={setAddOrgOpen}
        onCreated={(brand) => {
          onNavigate?.();
          void refresh();
          router.push(brandLocationHref(brand));
        }}
      />
    </>
  );
}

/**
 * An org, then its brands beneath it when it holds more than one. A single-brand org has
 * nothing to nest: its org home IS its brand overview, so listing the one brand underneath
 * would repeat the line above it.
 */
function OrgRows({
  org,
  activeOrgSlug,
  activeBrandSlug,
  onGo,
}: {
  org: Org;
  activeOrgSlug: string | null;
  activeBrandSlug: string | null;
  onGo: (href: string) => void;
}) {
  const nested = org.brands.length > 1;

  return (
    <>
      <CommandItem value={orgHref(org.slug)} keywords={[org.name, org.slug]} onSelect={onGo}>
        <Check
          className={cn("shrink-0", org.slug === activeOrgSlug ? "text-primary" : "opacity-0")}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{org.name}</span>
        {/* The count is what tells an operator a multi-brand org is worth expanding, before
            they click it and find out. A single-brand org states its one brand too, because
            "1" and a missing number are different facts. */}
        <span className="machine shrink-0 text-xs text-muted-foreground">
          {org.brands.length}
        </span>
      </CommandItem>

      {nested
        ? org.brands.map((brand) => (
            <CommandItem
              key={brand.slug}
              value={brandHref(org.slug, brand.slug)}
              keywords={[brand.name, brand.slug, org.name]}
              onSelect={onGo}
              className="pl-8"
            >
              <span
                aria-hidden
                className={cn(
                  "h-4 w-px shrink-0",
                  brand.slug === activeBrandSlug ? "bg-primary" : "bg-border",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  brand.slug === activeBrandSlug
                    ? "font-medium text-primary"
                    : "text-muted-foreground",
                )}
              >
                {brand.name}
              </span>
            </CommandItem>
          ))
        : null}
    </>
  );
}

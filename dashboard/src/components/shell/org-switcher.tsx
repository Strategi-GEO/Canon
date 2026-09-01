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
import {
  addBrandHref,
  brandHref,
  brandLocationHref,
  orgHref,
  useActiveOrg,
  useOrgs,
} from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { parseBrandPath } from "@/components/shell/nav";
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

  const brandSlug = parseBrandPath(pathname)?.brand ?? null;
  // The same resolution the sidebar's nav uses, so the label, the tick and the brand list below
  // always name one organisation. It also holds on /admin/new?org=, where the path names none and
  // the trigger used to read "Select an organisation" over a form addressed to a specific org.
  const activeOrg = useActiveOrg();

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

  // ROWS ACTUALLY DRAWN, which is not one per brand: a single-brand org is ONE combined row, so
  // counting its brand as well would show the filter a little before the list earns it.
  const rows = orgs.reduce(
    (total, org) => total + 1 + (org.brands.length > 1 ? org.brands.length : 0),
    0,
  );

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
        aria-label="Switch organisation or brand"
      >
        <span className="min-w-0 flex-1">
          {/* NAMES BOTH THINGS THE MENU HOLDS, because the row an operator picks can be either
              one: a multi-brand org lists its brands as their own rows, and a single-brand org is
              one combined row standing for both. Captioning it "Organisation" described the menu
              accurately only while brands were unreachable from it, which was the bug. The
              longhand matches the filter's own placeholder, "Find an organisation or brand", so
              the control says the same thing in both places. Truncates because the caption is not
              worth wrapping the trigger for on a narrow sidebar. */}
          <span className="block truncate text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            Organisation / Brand
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
                      activeOrgSlug={activeOrg?.slug ?? null}
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
 * A MULTI-BRAND ORG NESTS ITS BRANDS. A SINGLE-BRAND ORG IS ONE COMBINED ROW.
 * Admin only: the client portal does not mount this switcher.
 *
 * The nesting rule is the operator's: brands belong under the organisation where there is more
 * than one of them, and a single-brand org is not worth two lines, because on almost every one
 * of them the organisation IS the brand. That is true by construction on a brand carrying no
 * organisation, where the engine synthesises the org from the brand itself, so the second line
 * really would be an echo.
 *
 * THE COMBINED ROW STILL HAS TO CARRY THE BRAND, and that is the whole of what went wrong before.
 * The rule used to be `org.brands.length > 1` alone, and the single-brand row showed the ORG name
 * and nothing else. An operator created the organisation "Learning Edge" holding the single brand
 * "Cucoon"; the record was correct at every layer, and the word "Cucoon" appeared NOWHERE in this
 * switcher. Typing it into the filter answered "Nothing matches that", and the input's own
 * placeholder promises "Find an organisation or brand", so the answer did not merely fail to
 * help, it contradicted the control. The only reading left was that the brand had never been
 * created.
 *
 * SO THE ROW IS COMBINED RATHER THAN CUT DOWN TO THE ORG. It names the brand beside the
 * organisation when the two differ, and says the one name once when they do not, which is the
 * echo the rule exists to avoid. Every row also carries its brands as filter KEYWORDS, so a
 * brand-name search reaches its org in both shapes whatever is drawn.
 *
 * Renaming an org later moves a row between "one name" and "two names" and never between one row
 * and two, so the shape of the list stays a function of the brand COUNT, which is what the
 * operator asked for.
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
  // The one brand a combined row stands for, and only when it is named differently. Equal names
  // are the synthesised case, where showing it twice is the echo the nesting rule avoids.
  const soleBrand = nested ? null : org.brands[0];
  const brandSuffix = soleBrand && soleBrand.name !== org.name ? soleBrand.name : null;

  return (
    <>
      {/* The org row carries its BRANDS as keywords too, so a filter typed as a brand name
          reaches the org in both shapes: on a combined row it is the only thing that can match,
          and on a nested one it keeps the parent on screen beside the child. */}
      <CommandItem
        value={nested || !soleBrand ? orgHref(org.slug) : brandHref(org.slug, soleBrand.slug)}
        keywords={[org.name, org.slug, ...org.brands.flatMap((b) => [b.name, b.slug])]}
        onSelect={onGo}
      >
        <Check
          className={cn("shrink-0", org.slug === activeOrgSlug ? "text-primary" : "opacity-0")}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">
          {org.name}
          {brandSuffix ? (
            <span className="ml-1.5 text-xs text-muted-foreground">{brandSuffix}</span>
          ) : null}
        </span>
        {/* Only where something is folded away. On a combined row the count is always 1 and
            says nothing the row does not already show. */}
        {nested ? (
          <span className="machine shrink-0 text-xs text-muted-foreground">
            {org.brands.length}
          </span>
        ) : null}
      </CommandItem>

      {(nested ? org.brands : []).map((brand) => (
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
      ))}
    </>
  );
}

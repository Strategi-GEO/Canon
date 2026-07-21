"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { Box, Building2, Plus } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { BRAND_NAV, parseBrandPath } from "@/components/shell/nav";
import { HOSTED_READONLY } from "@/lib/hosted";
import { brandHref, orgHref, useOrgs } from "@/lib/orgs-context";
import { useHotkey } from "@/lib/use-hotkey";

type PaletteState = {
  open: () => void;
};

const CommandPaletteContext = React.createContext<PaletteState | null>(null);

/**
 * Lets the org switcher open the palette from its own trigger, so the keyboard route and the
 * pointer route land in the same place. Anything outside the provider gets a no-op rather
 * than a crash: a shortcut hint is never worth taking the shell down over.
 */
export function useCommandPalette(): PaletteState {
  return React.useContext(CommandPaletteContext) ?? NOOP;
}

const NOOP: PaletteState = { open: () => {} };

/**
 * Six operators share this dashboard and the hierarchy is two levels deep, so reaching a
 * brand's Blogs page by pointer costs an org switch, a brand switch and a nav click. The
 * palette collapses all three into one query, which is why it is the shell's primary
 * navigation and the sidebar is the discoverable fallback rather than the fast path.
 */
export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  // Toggle, not open: an operator who hits the shortcut twice means "put it away", and a
  // palette that only ever opens forces them to reach for Escape to undo their own reflex.
  useHotkey("mod+k", () => setOpen((current) => !current));

  const value = React.useMemo<PaletteState>(() => ({ open: () => setOpen(true) }), []);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} />
    </CommandPaletteContext.Provider>
  );
}

function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { orgs, error } = useOrgs();

  const parts = parseBrandPath(pathname);
  const activeOrg = orgs.find((org) => org.slug === parts?.org) ?? null;
  const activeBrand = activeOrg?.brands.find((brand) => brand.slug === parts?.brand) ?? null;

  function go(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  /**
   * Every item's cmdk value IS its href, so the highlighted item can be prefetched without a
   * second lookup table to keep in step. cmdk moves the value on hover as well as on arrow
   * keys, so this covers both ways an operator shows intent.
   */
  function prefetchHighlighted(value: string) {
    if (value.startsWith("/")) {
      router.prefetch(value);
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to an organisation, a brand, or a section of the brand you are in."
      className="max-w-xl"
    >
      <Command loop onValueChange={prefetchHighlighted}>
        <CommandInput placeholder="Search organisations, brands and sections" />
        <CommandList>
          <CommandEmpty className="text-sm text-muted-foreground">
            {error
              ? "Cannot reach the engine, so nothing can be listed here."
              : "Nothing matches that."}
          </CommandEmpty>

          {/* First, because an operator already inside a brand is far likelier to be moving
              within it than to be leaving it. */}
          {parts && activeBrand ? (
            <CommandGroup heading={activeBrand.name}>
              {BRAND_NAV.map((item) => {
                const href = brandHref(parts.org, parts.brand, item.section);
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={href}
                    value={href}
                    keywords={[item.label, activeBrand.name, activeBrand.slug]}
                    onSelect={go}
                  >
                    <Icon className="text-muted-foreground" aria-hidden />
                    <span>{item.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          {orgs.length > 0 ? (
            <>
              {parts && activeBrand ? <CommandSeparator /> : null}

              <CommandGroup heading="Brands">
                {orgs.flatMap((org) =>
                  org.brands.map((brand) => {
                    const href = brandHref(org.slug, brand.slug);
                    return (
                      <CommandItem
                        key={href}
                        value={href}
                        keywords={[brand.name, brand.slug, org.name, org.slug]}
                        onSelect={go}
                      >
                        <Box className="text-muted-foreground" aria-hidden />
                        <span className="min-w-0 truncate">{brand.name}</span>
                        {/* The org only earns a mention when it is not just the brand's name
                            repeated, which is the single-brand-org case and most of them. */}
                        {org.name === brand.name ? null : (
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {org.name}
                          </span>
                        )}
                        {brand.demo_mode ? <DemoTag /> : null}
                      </CommandItem>
                    );
                  }),
                )}
              </CommandGroup>

              {/* Orgs last: an org owns no facts and no roadmap, so landing on one is rarely
                  what the operator actually wanted. */}
              <CommandGroup heading="Organisations">
                {orgs.map((org) => {
                  const href = orgHref(org.slug);
                  return (
                    <CommandItem
                      key={href}
                      value={href}
                      keywords={[org.name, org.slug]}
                      onSelect={go}
                    >
                      <Building2 className="text-muted-foreground" aria-hidden />
                      <span className="min-w-0 truncate">{org.name}</span>
                      <span className="machine ml-auto shrink-0 text-xs text-muted-foreground">
                        {org.brands.length} {org.brands.length === 1 ? "brand" : "brands"}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </>
          ) : null}

          {/* Onboarding is an engine write, so the hosted, read-only build offers no route
              to it. */}
          {HOSTED_READONLY ? null : (
            <>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem
                  value="/admin/new"
                  keywords={["add organisation", "add client", "new organisation", "new brand"]}
                  onSelect={go}
                >
                  <Plus className="text-muted-foreground" aria-hidden />
                  <span>Add organisation</span>
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

/**
 * Muted grey, never the accent. A demo brand produces precoded fake blogs and can never spend
 * an API call, so the badge marks a limitation rather than a feature.
 */
function DemoTag() {
  return (
    <span className="machine shrink-0 rounded border border-border bg-muted px-1 py-px text-[0.625rem] leading-tight text-muted-foreground">
      Demo
    </span>
  );
}

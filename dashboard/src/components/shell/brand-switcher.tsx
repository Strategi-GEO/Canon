"use client";

import Link from "next/link";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { brandHref } from "@/lib/orgs-context";
import { cn } from "@/lib/utils";
import type { Org } from "@/types";

/**
 * A compact brand picker directly above the brand nav, shown only inside a multi-brand org.
 *
 * It keeps the current section when it switches, so an operator comparing two brands' blogs
 * stays on Blogs instead of being dropped back on an overview they did not ask for.
 */
export function BrandSwitcher({
  org,
  activeBrandSlug,
  section,
  onNavigate,
}: {
  org: Org;
  activeBrandSlug: string;
  section: string;
  onNavigate?: () => void;
}) {
  const active = org.brands.find((brand) => brand.slug === activeBrandSlug);

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
        <DropdownMenuLabel className="truncate">{org.name}</DropdownMenuLabel>
        {org.brands.map((brand) => (
          <DropdownMenuItem key={brand.slug} asChild>
            <Link
              href={brandHref(org.slug, brand.slug, section)}
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

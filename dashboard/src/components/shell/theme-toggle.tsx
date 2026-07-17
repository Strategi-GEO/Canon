"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/lib/use-theme";
import type { ThemePref } from "@/lib/theme";

/**
 * Light / dark / system, in the topbar with the rest of the app furniture.
 *
 * The trigger shows the RESOLVED theme via CSS alone (`dark:hidden`), never via state:
 * the SSR render has no localStorage to read, so a state-driven icon would hydrate wrong
 * for a frame. The class on <html> is already correct before first paint, and CSS reads it
 * for free. The menu's checkmark can afford state because a menu only opens after mount.
 */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme" title="Change theme">
          <Sun className="dark:hidden" aria-hidden />
          <Moon className="hidden dark:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-32">
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(value) => setPref(value as ThemePref)}
        >
          <DropdownMenuRadioItem value="light">
            <Sun aria-hidden />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon aria-hidden />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor aria-hidden />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import * as React from "react";
import {
  getThemePref,
  resolveTheme,
  setThemePref,
  subscribeTheme,
  type ThemePref,
} from "@/lib/theme";

/**
 * The theme as React state. Read in an effect, never during render: the first render is
 * also the SSR render, and there is no localStorage there. The inline init script has
 * already painted the right theme by then, so the "system" default here never flashes,
 * it only describes the toggle's checkmark for a frame.
 */
export function useTheme(): {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref: (pref: ThemePref) => void;
} {
  const [pref, setPrefState] = React.useState<ThemePref>("system");
  const [resolved, setResolved] = React.useState<"light" | "dark">("light");

  React.useEffect(() => {
    const read = () => {
      const current = getThemePref();
      setPrefState(current);
      setResolved(resolveTheme(current));
    };
    read();
    return subscribeTheme(read);
  }, []);

  return { pref, resolved, setPref: setThemePref };
}

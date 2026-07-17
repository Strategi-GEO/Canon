/**
 * The theme preference: a browser preference in the same class as the last-visited org.
 * Nothing on the server can contradict it, so a stale copy costs a repaint and never lies
 * about the engine.
 *
 * Three values, not two. "system" follows prefers-color-scheme live, so an operator who
 * never touches the toggle gets the OS theme including overnight switches. The resolved
 * theme is applied as a `.dark` class on <html>, which is what globals.css binds every
 * dark token and every `dark:` utility to.
 *
 * Every localStorage read and write for the theme lives in THIS file, guarded for SSR.
 */

export type ThemePref = "light" | "dark" | "system";

export const THEME_KEY = "strategi-canon.theme";

/**
 * Runs in <head> before first paint (see layout.tsx), so a dark-preferring operator never
 * sees a light flash. It must stay dependency-free and byte-small: it is inlined into every
 * page. The logic mirrors resolveTheme below exactly; the two must not drift.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("strategi-canon.theme");var d=t==="dark"||(t!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})()`;

const THEME_EVENT = "strategi-canon:theme";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The stored preference, defaulting to "system" for a value never set or not recognised. */
export function getThemePref(): ThemePref {
  if (typeof window === "undefined") {
    return "system";
  }
  const raw = window.localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** What a preference paints as right now. "system" resolves against the live media query. */
export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return pref;
}

/** Stamps the resolved theme onto <html>. The one writer of the class besides the init script. */
function applyTheme(): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.toggle("dark", resolveTheme(getThemePref()) === "dark");
}

function notify(): void {
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function setThemePref(pref: ThemePref): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(THEME_KEY, pref);
  applyTheme();
  notify();
}

/**
 * Fires on any change that can repaint the theme: the toggle in this tab, the toggle in
 * another tab (storage event), and the OS switching while the preference is "system".
 */
export function subscribeTheme(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) {
      applyTheme();
      callback();
    }
  };
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => {
    if (getThemePref() === "system") {
      applyTheme();
      callback();
    }
  };
  window.addEventListener(THEME_EVENT, callback);
  window.addEventListener("storage", onStorage);
  media.addEventListener("change", onMedia);
  return () => {
    window.removeEventListener(THEME_EVENT, callback);
    window.removeEventListener("storage", onStorage);
    media.removeEventListener("change", onMedia);
  };
}

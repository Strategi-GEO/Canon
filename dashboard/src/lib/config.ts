/**
 * Where the API lives, and it is read in the browser, so it has to be a NEXT_PUBLIC_ var.
 *
 * LOCAL (the default dev setup): the dashboard runs on 3000 and calls the FastAPI engine on
 * 8000 directly, so dev keeps the localhost:8000 fallback it has always had.
 *
 * HOSTED (Vercel): NEXT_PUBLIC_API_BASE is deliberately unset and the base falls back to ""
 * (same origin), so every existing fetch lands on the Next.js Route Handlers under /api/*,
 * which read Supabase directly. The localhost fallback applies ONLY when NODE_ENV is
 * development AND NEXT_PUBLIC_HOSTED_READONLY is not set: a production build, or any build
 * that declares itself hosted, must never default to a developer's local engine.
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (process.env.NODE_ENV === "development" && !process.env.NEXT_PUBLIC_HOSTED_READONLY
    ? "http://localhost:8000"
    : "");

/**
 * The last org the operator looked at, used ONLY to pick a target for the / redirect.
 * The active brand is never stored: the ROUTE is the authority for that, because a URL is
 * shareable, refresh proof and back button proof, while localStorage is none of those and
 * would fight the address bar the moment the two disagreed.
 */
export const LAST_ORG_KEY = "geo-factory.last-org";

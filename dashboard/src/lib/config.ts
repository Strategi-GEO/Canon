/**
 * The dashboard runs on 3000 and calls the FastAPI engine on 8000 directly, so the base
 * URL has to be a NEXT_PUBLIC_ var: it is read in the browser, not on the server.
 */
export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

/**
 * The last org the operator looked at, used ONLY to pick a target for the / redirect.
 * The active brand is never stored: the ROUTE is the authority for that, because a URL is
 * shareable, refresh proof and back button proof, while localStorage is none of those and
 * would fight the address bar the moment the two disagreed.
 */
export const LAST_ORG_KEY = "geo-factory.last-org";

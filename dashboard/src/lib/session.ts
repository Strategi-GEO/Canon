import { API_BASE } from "@/lib/config";

/**
 * The browser's copy of the engine session, over localStorage so the admin stays signed in
 * across browser restarts. The ENGINE is the authority on whether a token is any good: this
 * module only stores what POST /api/login and /api/refresh returned and keeps the access
 * token fresh. It deliberately imports nothing from api.ts, because api.ts calls into here
 * on every request and a cycle would be the price of the convenience.
 *
 * Every localStorage read and write is guarded for SSR: Next prerenders these client
 * components once on the server, where there is no window and no session, and the honest
 * answer there is "no session yet", never a crash.
 */

export type SessionUser = {
  id: string;
  email: string;
};

export type Session = {
  access_token: string;
  refresh_token: string;
  /** Unix seconds, straight from the engine's GoTrue proxy. */
  expires_at: number;
  user: SessionUser;
};

const SESSION_KEY = "geo-factory.session";

/**
 * Refresh once the token is within this many seconds of expiry. Wide enough that a request
 * started just before the deadline still lands with a live token, narrow enough that the
 * refresh token is not churned on every request.
 */
const REFRESH_WINDOW_S = 90;

/**
 * Fired on window whenever the stored session changes IN THIS TAB. localStorage's own
 * "storage" event fires only in OTHER tabs, so without this a sign-out would update every
 * tab except the one it happened in.
 */
export const SESSION_EVENT = "geo-factory:session";

function announce(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_EVENT));
  }
}

export function getSession(): Session | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Session;
    if (
      typeof parsed?.access_token === "string" &&
      typeof parsed?.refresh_token === "string" &&
      typeof parsed?.expires_at === "number" &&
      typeof parsed?.user?.email === "string"
    ) {
      return parsed;
    }
  } catch {
    // Fall through: whatever is stored is not a session.
  }
  // Malformed storage reads as signed out rather than crashing every request forever.
  window.localStorage.removeItem(SESSION_KEY);
  return null;
}

export function setSession(session: Session): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  announce();
}

export function clearSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(SESSION_KEY);
  announce();
}

/** The current access token, fresh or not, or null when signed out. */
export function getAccessToken(): string | null {
  return getSession()?.access_token ?? null;
}

/**
 * One refresh in flight at a time. Every concurrent caller awaits the same promise, because
 * a refresh token is single use on the GoTrue side: two parallel refreshes would race, and
 * the loser would clear a session the winner had just renewed.
 */
let refreshing: Promise<string | null> | null = null;

/**
 * The token every request should carry: the stored one while it has life left, a freshly
 * refreshed one when it is within the refresh window, and null when there is no session or
 * the engine refused the refresh (which clears the session, so the guard sends the operator
 * back to /login).
 */
export async function ensureFreshToken(): Promise<string | null> {
  const session = getSession();
  if (session === null) {
    return null;
  }
  if (session.expires_at - Date.now() / 1000 > REFRESH_WINDOW_S) {
    return session.access_token;
  }
  refreshing ??= refresh(session.refresh_token).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refresh(refreshToken: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // The engine is unreachable, which says nothing about whether the session is valid.
    // Keep it: the request about to be made will fail with the honest "cannot reach the
    // engine" instead of silently signing the admin out because the engine was restarting.
    return getAccessToken();
  }

  if (!res.ok) {
    // The engine ANSWERED and said no: the refresh token is dead, so the session is over.
    clearSession();
    return null;
  }

  const next = (await res.json()) as Session;
  setSession({
    access_token: next.access_token,
    refresh_token: next.refresh_token,
    expires_at: next.expires_at,
    user: next.user,
  });
  return next.access_token;
}

/**
 * Keeps the token fresh while the app is open, so an EventSource opened from a sync call
 * site (which cannot await a refresh) always finds a live token in storage. The 30s cadence
 * against the 90s window means at least two chances to renew before any token expires, and
 * an interval survives laptop sleep better than a single timeout aimed at the deadline.
 * Returns the stop function, shaped for a React effect.
 */
export function startSessionRefreshTimer(): () => void {
  void ensureFreshToken();
  const id = window.setInterval(() => {
    void ensureFreshToken();
  }, 30_000);
  return () => window.clearInterval(id);
}

/**
 * Notifies on any session change: this tab's own writes via SESSION_EVENT, other tabs' via
 * the storage event. Returns the unsubscribe, shaped for a React effect.
 */
export function subscribeSession(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_KEY || event.key === null) {
      onChange();
    }
  };
  window.addEventListener(SESSION_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SESSION_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Best-effort revoke, then the local clear that actually signs this browser out. The revoke
 * is fire-and-forget on purpose: the engine answers 204 no matter what, and a dead engine
 * must not be able to hold the operator signed in.
 */
export function signOut(): void {
  const session = getSession();
  if (session !== null) {
    void fetch(`${API_BASE}/api/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    }).catch(() => {
      // Revoke is best-effort; the local clear below is what signs out.
    });
  }
  clearSession();
}

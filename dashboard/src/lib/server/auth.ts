import { createRemoteJWKSet, jwtVerify } from "jose";
import { supabaseAnonKey, supabaseUrl } from "@/lib/server/env";
import { detail } from "@/lib/server/http";

/**
 * Token verification for the hosted-mode Route Handlers, mirroring server/auth.py:
 * verification is LOCAL, one signature check against the project JWKS, and GoTrue is only on
 * the wire for login, refresh, and logout. The alg is PINNED to ES256, which is what the
 * project's JWKS actually serves; accepting whatever the token header claims is how
 * alg-confusion downgrades happen. aud must be "authenticated" because that is what GoTrue
 * stamps on a user session, and a service or anon JWT does not carry it.
 */

const AUDIENCE = "authenticated";
const ALGORITHMS = ["ES256"];

export type Verified = {
  /** The raw bearer token, forwarded to PostgREST so RLS answers as this user. */
  token: string;
  userId: string;
  email: string;
};

/**
 * jose's remote JWK set caches keys and rate-limits refetches on unknown kids, which is the
 * same posture server/auth.py hand-rolls. One instance per process, created lazily so a
 * build with no env never touches it.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksOrigin: string | null = null;

function keySet(): ReturnType<typeof createRemoteJWKSet> {
  const url = supabaseUrl();
  if (jwks === null || jwksOrigin !== url) {
    jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    jwksOrigin = url;
  }
  return jwks;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }
  const [scheme, ...rest] = header.split(" ");
  const token = rest.join(" ").trim();
  if (scheme.toLowerCase() !== "bearer" || token === "") {
    return null;
  }
  return token;
}

/**
 * The verified caller, or null for every failure mode. One outcome for every reason a token
 * is not accepted, exactly like the engine's require_user: distinguishing "expired" from
 * "bad signature" on the wire would only build an oracle.
 */
export async function verifyRequest(request: Request): Promise<Verified | null> {
  const token = bearerToken(request);
  if (token === null) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, keySet(), {
      audience: AUDIENCE,
      algorithms: ALGORITHMS,
      requiredClaims: ["exp", "sub"],
    });
    return {
      token,
      userId: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : "",
    };
  } catch {
    return null;
  }
}

/** The engine's one 401, word for word, so api.ts's redirect-to-login path behaves identically. */
export function unauthenticated(): Response {
  return detail(401, "authentication required");
}

// ---------------------------------------------------------------------------
// GoTrue proxies: login, refresh, logout. The apikey here is the ANON key, which is exactly
// enough for the password and refresh-token grants; the SECRET key is never in this app.
// ---------------------------------------------------------------------------

export class GoTrueRefused extends Error {}

type GoTrueSession = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id?: string; email?: string };
};

async function goTrueToken(grantType: string, payload: Record<string, string>): Promise<GoTrueSession> {
  const res = await fetch(`${supabaseUrl()}/auth/v1/token?grant_type=${grantType}`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new GoTrueRefused(`gotrue ${grantType} grant refused: HTTP ${res.status}`);
  }
  return (await res.json()) as GoTrueSession;
}

/**
 * EXACTLY the contract shape, nothing more, mirroring server/auth.py's _session_payload:
 * GoTrue's response carries fields (weak_password, full user metadata) the frontend has no
 * business seeing, so everything else is stripped here.
 */
function sessionPayload(body: GoTrueSession) {
  if (!body.access_token || !body.refresh_token) {
    throw new GoTrueRefused("gotrue answered 200 without a session");
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in ?? null,
    expires_at: body.expires_at ?? null,
    user: { id: body.user?.id ?? null, email: body.user?.email ?? null },
  };
}

export async function login(email: string, password: string) {
  return sessionPayload(await goTrueToken("password", { email, password }));
}

export async function refresh(refreshToken: string) {
  return sessionPayload(await goTrueToken("refresh_token", { refresh_token: refreshToken }));
}

/**
 * Best effort, never throws, mirroring server/auth.py's logout: GoTrue revokes by ACCESS
 * token, so the only path in from a refresh token is to redeem it first and then revoke the
 * session it belongs to. A refresh token that no longer redeems is a session already dead,
 * which is the outcome logout wants.
 */
export async function logout(refreshToken: string): Promise<void> {
  try {
    const body = await goTrueToken("refresh_token", { refresh_token: refreshToken });
    if (!body.access_token) {
      return;
    }
    await fetch(`${supabaseUrl()}/auth/v1/logout`, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey(),
        Authorization: `Bearer ${body.access_token}`,
      },
      cache: "no-store",
    });
  } catch {
    // Best effort by contract: the browser is discarding its tokens either way.
  }
}

import { clearSession, ensureFreshToken } from "@/lib/session";
import type {
  AnswersBody,
  ApproveBody,
  IndexResourceBody,
  Overview,
  PortalBlogDetail,
  PortalResource,
  PortalResourceLink,
  PortalReports,
  PortalResourceList,
  PortalRoadmap,
  PortalUploadTarget,
  ReplyBody,
  SuggestBody,
} from "@/portal/types";
import type { RoadmapMonthsResponse } from "@/types";

/**
 * The portal's API client. Same-origin only: the portal's Route Handlers ARE its backend,
 * so there is no base URL and no cross-origin story. Every request carries the session's
 * bearer token; any 401 off /api/login clears the session and lands on /login.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detailValue: unknown) {
    super(typeof detailValue === "string" ? detailValue : `request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detailValue;
  }

  get isOffline(): boolean {
    return this.status === 0;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await ensureFreshToken();
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

function handleUnauthorized(path: string, status: number): void {
  if (status === 401 && path !== "/api/login" && typeof window !== "undefined") {
    clearSession();
    window.location.assign("/login");
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = await authHeader();
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    throw new ApiError(0, "Cannot reach the portal");
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    handleUnauthorized(path, res.status);
    const detailValue =
      typeof parsed === "object" && parsed !== null && "detail" in parsed
        ? (parsed as { detail: unknown }).detail
        : parsed;
    throw new ApiError(res.status, detailValue);
  }
  return parsed as T;
}

export const api = {
  /**
   * The ONE bit the client shell needs about the caller: are they an operator? Same-origin
   * /api/me (the app's own Route Handler, never the engine), so the client interface stays
   * engine-less. An operator who lands on a client URL is bounced to /admin by the layout.
   */
  me: (signal?: AbortSignal) => request<{ is_admin: boolean }>("/api/me", { signal }),
  overview: (signal?: AbortSignal) => request<Overview>("/api/overview", { signal }),
  blog: (brand: string, topic: string, signal?: AbortSignal) =>
    request<PortalBlogDetail>(
      `/api/blog/${encodeURIComponent(brand)}/${encodeURIComponent(topic)}`,
      { signal },
    ),
  answer: (brand: string, topic: string, body: AnswersBody) =>
    request<unknown>(
      `/api/blog/${encodeURIComponent(brand)}/${encodeURIComponent(topic)}/answers`,
      { method: "POST", body },
    ),
  /**
   * The review-loop writes, POSTs to the portal's own Route Handlers, which call the
   * database's definer functions with the caller's JWT exactly as answers does.
   *
   * Approve carries the VERSION the client read, taken from the detail payload they are
   * looking at. It is not decoration: the record compares it with the version currently on
   * offer and refuses a mismatch, so a team re-send that lands while somebody is reading
   * cannot collect an approval for bytes nobody saw.
   */
  approveBlog: (brand: string, topic: string, body: ApproveBody) =>
    request<unknown>(
      `/api/blog/${encodeURIComponent(brand)}/${encodeURIComponent(topic)}/approve`,
      { method: "POST", body },
    ),
  suggestChange: (brand: string, topic: string, body: SuggestBody) =>
    request<unknown>(
      `/api/blog/${encodeURIComponent(brand)}/${encodeURIComponent(topic)}/suggest`,
      { method: "POST", body },
    ),
  /** One line added to an existing suggestion's thread. Never changes that suggestion's
   *  state: answering the team is not withdrawing the request. */
  replyComment: (brand: string, topic: string, body: ReplyBody) =>
    request<unknown>(
      `/api/blog/${encodeURIComponent(brand)}/${encodeURIComponent(topic)}/reply`,
      { method: "POST", body },
    ),
  roadmap: (brand: string, signal?: AbortSignal, month?: number) =>
    request<PortalRoadmap>(
      `/api/roadmap/${encodeURIComponent(brand)}` +
        (month === undefined ? "" : `?month=${month}`),
      { signal },
    ),

  /** The months list for the roadmap tab. Sits under /api/clients/{slug}/... for the same
   *  reason the resources routes do (RLS on the caller's own JWT, only client-granted
   *  columns): see the comment above `resources:`. */
  roadmapMonths: (brand: string, signal?: AbortSignal) =>
    request<RoadmapMonthsResponse>(
      `/api/clients/${encodeURIComponent(brand)}/roadmap/months`,
      { signal },
    ),

  /** The brand's shared monthly reports, read-only. Empty `months` when nothing is shared yet. */
  reports: (brand: string, signal?: AbortSignal) =>
    request<PortalReports>(`/api/reports/${encodeURIComponent(brand)}`, { signal }),

  /**
   * The brand's own fact base. These four sit under /api/clients/{slug}/... rather than in the
   * portal's own /api/blog and /api/roadmap namespace, and that is deliberate rather than
   * sloppy: those two namespaces exist because a blog reaches a client NARROWED, with the
   * score, the iterations and the eval artifacts stripped at the boundary. A resource has no
   * internal half to strip. It is the client's file, the same four fields under both roofs,
   * and every one of these routes scopes itself by RLS on the caller's own JWT, so a second
   * set of handlers answering the same rows would only be a second place for the scoping to
   * drift.
   */
  resources: (brand: string, signal?: AbortSignal) =>
    request<PortalResourceList>(`/api/clients/${encodeURIComponent(brand)}/resources`, { signal }),

  /**
   * A ticket for one file's bytes. `download` asks Storage for an attachment disposition
   * carrying the original filename, so a save-as writes what the client uploaded rather than
   * the sha256 the object is stored under.
   */
  resourceLink: (
    brand: string,
    name: string,
    options: { download?: boolean; signal?: AbortSignal } = {},
  ) =>
    request<PortalResourceLink>(
      `/api/clients/${encodeURIComponent(brand)}/resources/${encodeURIComponent(name)}` +
        (options.download === true ? "?download=1" : ""),
      { signal: options.signal },
    ),

  /** Step one of an upload: where to PUT the bytes. See PortalUploadTarget for why. */
  resourceUploadTarget: (brand: string, body: { sha256: string }) =>
    request<PortalUploadTarget>(
      `/api/clients/${encodeURIComponent(brand)}/resources/upload-url`,
      { method: "POST", body },
    ),

  /**
   * Step two: the index row, written only once the bytes are up. A 409 here is the duplicate
   * refusal, and it is a refusal by design: the record holds one row per filename per brand
   * and there is no upsert anywhere in the path, so nothing this call can do overwrites a file
   * the client already has.
   */
  indexResource: (brand: string, body: IndexResourceBody) =>
    request<{ resource: PortalResource }>(
      `/api/clients/${encodeURIComponent(brand)}/resources`,
      { method: "POST", body },
    ),

  deleteResource: (brand: string, name: string) =>
    request<unknown>(
      `/api/clients/${encodeURIComponent(brand)}/resources/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),
};

/**
 * The one request in this app that does not go to our own origin, and the one that carries no
 * bearer token of ours.
 *
 * It cannot use request() above, and the reasons are not stylistic. request() attaches the
 * session's Authorization header, which would be handing our JWT to a third-party host; it
 * JSON-encodes the body, where these bytes must travel raw; and it routes every 401 through
 * clearSession(), so a Storage refusal would sign the client out of the portal. What travels
 * instead is exactly what the server put in the target: a URL scoped to one object key and the
 * headers it told us to send.
 *
 * A failure lands as ApiError so the view handles it beside every other failure it renders,
 * with status 0 reserved for "the request never completed", which is what ApiError.isOffline
 * already means everywhere else.
 */
export async function putResourceBytes(
  target: PortalUploadTarget,
  file: File,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: file,
      signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    throw new ApiError(0, "The upload could not reach our file store");
  }
  if (!res.ok) {
    // Storage answers XML or JSON depending on the failure, and neither is a sentence a client
    // should read, so the status travels and the view writes the words. It never reaches
    // handleUnauthorized: a 401 from Storage means this URL expired, not that our session did.
    throw new ApiError(res.status, `The file store refused the upload (${res.status})`);
  }
}

/** The server's own words for an error, for inline rendering next to the failed control. */
export function detailText(error: ApiError): string {
  if (typeof error.detail === "string") {
    return error.detail;
  }
  if (
    typeof error.detail === "object" &&
    error.detail !== null &&
    "detail" in error.detail &&
    typeof (error.detail as { detail: unknown }).detail === "string"
  ) {
    return (error.detail as { detail: string }).detail;
  }
  return error.message;
}

/**
 * True when the approve route refused because the article on offer moved while the client
 * was reading it.
 *
 * The flag travels as a FIELD on the error body rather than as words in the message, and
 * that is the whole reason it exists: every other refusal the approve route can give is
 * also a 409, and the one branch that must not be silent is this one. The others mean the
 * record has already moved past the button, so re-reading the page answers them; this one
 * means the client's approval did not land and they have a different article in front of
 * them than the one they signed off. Matching on the message text would put that
 * distinction one copy edit away from vanishing.
 */
export function isStaleVersion(error: ApiError): boolean {
  return (
    typeof error.detail === "object" &&
    error.detail !== null &&
    (error.detail as { stale?: unknown }).stale === true
  );
}

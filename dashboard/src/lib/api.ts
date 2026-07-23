import { API_BASE } from "@/lib/config";
import { clearSession, ensureFreshToken, getAccessToken } from "@/lib/session";
import type {
  AddCommentBody,
  AnalysisGenJob,
  AnalysisResponse,
  AnswersBody,
  AppUpdateCheck,
  AppUpdateResult,
  AppVersion,
  BlogComment,
  BlogCommentReply,
  BlogCommentsResponse,
  BlogQuestions,
  BlogReviewState,
  BlogsResponse,
  ClientsResponse,
  CreateClientBody,
  DescribeJob,
  DescribeJobsResponse,
  FactsGenJob,
  GenerateAccepted,
  GenerateBody,
  GenerateRoadmapBody,
  IndustriesResponse,
  MeResponse,
  Org,
  OrgsResponse,
  OutputFile,
  PublishResult,
  ReportGenJob,
  ReportsResponse,
  ShareReportResult,
  ResourcesResponse,
  RoadmapGenJob,
  RoadmapMonthsResponse,
  RoadmapResponse,
  RoadmapSheet,
  RunSummary,
  RunsResponse,
  SaveContentResult,
  StopRunsResult,
  UpdateClientBody,
  UploadBlogResult,
  Client,
} from "@/types";

/**
 * The engine answers refusals with real reasons: 409 carries a duplicates array, 422 a
 * per-row missing list, 400 a plain detail string, 413 an oversized upload. Those reasons
 * are the whole point of the error, so ApiError carries the parsed body through untouched
 * and a page renders the server's own words instead of "something went wrong".
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly body: unknown;

  constructor(status: number, detail: unknown, body: unknown) {
    super(describe(status, detail));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
  }

  /** True when the network never reached the engine, as opposed to the engine refusing. */
  get isOffline(): boolean {
    return this.status === 0;
  }
}

/**
 * A best effort one line summary for logs and toasts. Pages that care about structure
 * should read `body` rather than parse this string.
 */
function describe(status: number, detail: unknown): string {
  if (status === 0) {
    return "Cannot reach the engine";
  }
  if (typeof detail === "string" && detail.trim() !== "") {
    return detail;
  }
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: string; missing?: string[] };
    if (typeof first?.msg === "string") {
      return first.msg;
    }
    if (Array.isArray(first?.missing)) {
      return `Row is missing: ${first.missing.join(", ")}`;
    }
  }
  return `Request failed with status ${status}`;
}

function url(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * The Authorization header for one request, refreshed first when the token is near expiry.
 * Null when signed out, and the request then goes out bare: the engine answers it 401,
 * which lands in handleUnauthorized below and puts the operator on /login.
 */
async function authHeader(): Promise<Record<string, string>> {
  const token = await ensureFreshToken();
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * A 401 anywhere but /api/login means the session is dead: expired past refresh, revoked,
 * or forged. The stored copy is a lie now, so drop it and hard-redirect to /login. On
 * /api/login itself a 401 is just a wrong password, which is the page's own error to show.
 */
function handleUnauthorized(path: string, status: number): void {
  if (status !== 401 || path === "/api/login") {
    return;
  }
  clearSession();
  // ONE APP, ONE LOGIN at the site root. A dead session anywhere (admin or client) lands on
  // /login, which re-authenticates and routes back by role. The guard avoids a redundant
  // reload when the caller is already there.
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
}

/**
 * Reads the body once, as text, then tries JSON. A 413 from a proxy can arrive as HTML and
 * a stream can only be consumed once, so text first is the only way to never lose a body.
 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Multipart uploads set their own Content-Type boundary, so pass FormData here. */
  form?: FormData;
};

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, signal, form } = options;

  const headers: Record<string, string> = await authHeader();
  if (!form && body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url(path), {
      method,
      signal,
      headers,
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch (cause) {
    // A refused connection or a CORS block is not a server refusal, and pretending it is
    // would send an operator hunting for a bug in their CSV. Status 0 keeps them apart.
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    throw new ApiError(0, "Cannot reach the engine", { cause: String(cause) });
  }

  const parsed = await readBody(res);

  if (!res.ok) {
    handleUnauthorized(path, res.status);
    const detail =
      parsed && typeof parsed === "object" && "detail" in parsed
        ? (parsed as { detail: unknown }).detail
        : parsed;
    throw new ApiError(res.status, detail, parsed);
  }

  return parsed as T;
}

/**
 * Binary bodies (resource previews and downloads), authenticated like every other request.
 * The error path still reads text: the engine's refusals are JSON or plain prose, and a
 * refusal wrapped in a Blob would be a reason nobody can render.
 */
export async function requestBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url(path), { signal, headers: await authHeader() });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    throw new ApiError(0, "Cannot reach the engine", { cause: String(cause) });
  }

  if (!res.ok) {
    const text = await res.text();
    handleUnauthorized(path, res.status);
    throw new ApiError(res.status, text, text);
  }
  return res.blob();
}

/** Artifacts come back as text/plain, so they bypass the JSON path entirely. */
export async function requestText(path: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url(path), { signal, headers: await authHeader() });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw cause;
    }
    throw new ApiError(0, "Cannot reach the engine", { cause: String(cause) });
  }

  const text = await res.text();
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    throw new ApiError(res.status, text, text);
  }
  return text;
}

export const api = {
  /**
   * Who this token is. The shell and the login page read is_admin off it to keep client
   * logins out of this console entirely: their credential is for the Client Portal, and
   * every admin surface here assumes a Strategi operator is behind the keyboard.
   */
  me: (signal?: AbortSignal) => request<MeResponse>("/api/me", { signal }),

  clients: (signal?: AbortSignal) => request<ClientsResponse>("/api/clients", { signal }),

  /** The org grouping over brands. Derived by the engine, so it never drifts from clients. */
  orgs: (signal?: AbortSignal) => request<OrgsResponse>("/api/orgs", { signal }),

  org: (slug: string, signal?: AbortSignal) => request<Org>(`/api/orgs/${slug}`, { signal }),

  industries: (signal?: AbortSignal) =>
    request<IndustriesResponse>("/api/industries", { signal }),

  createClient: (body: CreateClientBody) =>
    request<Client>("/api/clients", { method: "POST", body }),

  client: (slug: string, signal?: AbortSignal) =>
    request<Client>(`/api/clients/${slug}`, { signal }),

  updateClient: (slug: string, body: UpdateClientBody) =>
    request<Client>(`/api/clients/${slug}`, { method: "PATCH", body }),

  /**
   * Starts a draft and returns the JOB, never the description: 202, and the field is null at
   * this instant. The engine owns the session, so the browser starts it and then watches.
   * A POST while one is already running returns that job rather than starting a rival.
   */
  startDescribe: (slug: string) =>
    request<DescribeJob>(`/api/clients/${slug}/describe`, { method: "POST" }),

  /** One brand's draft job, or 404 when the engine holds none. This is what survives a refresh. */
  describeJob: (slug: string, signal?: AbortSignal) =>
    request<DescribeJob>(`/api/clients/${slug}/describe`, { signal }),

  /** Every draft job the engine holds, so a watcher discovers one it never started. */
  describeJobs: (signal?: AbortSignal) =>
    request<DescribeJobsResponse>("/api/describe-jobs", { signal }),

  /**
   * Drops a SETTLED job once the operator has taken or dismissed the draft. 204, so there is no
   * body to hand back. A running job is deliberately not cancellable: the session is already
   * spending quota, so it lands and the operator discards the result.
   */
  clearDescribeJob: (slug: string) =>
    request<null>(`/api/clients/${slug}/describe`, { method: "DELETE" }),

  resources: (slug: string, signal?: AbortSignal) =>
    request<ResourcesResponse>(`/api/clients/${slug}/resources`, { signal }),

  uploadResource: (slug: string, form: FormData) =>
    request<ResourcesResponse>(`/api/clients/${slug}/resources`, { method: "POST", form }),

  deleteResource: (slug: string, name: string) =>
    request<ResourcesResponse>(
      `/api/clients/${slug}/resources/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  /**
   * One resource's bytes, streamed by the engine from content-addressed Storage, so what
   * comes back is the ORIGINAL uploaded file byte for byte. `download: true` asks the
   * engine for its attachment disposition; the browser saves either way, so the flag is
   * honesty about intent more than behaviour. Needs the live engine, never hosted.
   */
  resourceFile: (
    slug: string,
    name: string,
    options?: { download?: boolean; signal?: AbortSignal },
  ) =>
    requestBlob(
      `/api/clients/${slug}/resources/${encodeURIComponent(name)}${
        options?.download ? "?download=1" : ""
      }`,
      options?.signal,
    ),

  uploadRoadmap: (slug: string, form: FormData) =>
    request<RoadmapResponse>(`/api/clients/${slug}/roadmap/upload`, {
      method: "POST",
      form,
    }),

  roadmap: (slug: string, signal?: AbortSignal, month?: number) =>
    request<RoadmapResponse>(
      `/api/clients/${slug}/roadmap${month === undefined ? "" : `?month=${month}`}`,
      { signal },
    ),

  /**
   * The whole sheet, every column of it, for the preview. This is the file rather than the
   * engine's three-column reading of it, so it is a separate call from `roadmap` and is worth
   * a second round trip: it carries columns nothing acts on, and most visits never ask for it.
   * `month` picks which of the brand's monthly roadmaps to read; omitted reads the latest.
   * 404 means the brand has no roadmap.csv, the same empty state `roadmap` answers with.
   */
  roadmapSheet: (slug: string, signal?: AbortSignal, month?: number) =>
    request<RoadmapSheet>(
      `/api/clients/${slug}/roadmap/sheet${month === undefined ? "" : `?month=${month}`}`,
      { signal },
    ),

  /**
   * Every month's roadmap this brand holds, month ASCENDING. Unlike `roadmap`, an EMPTY list is
   * a 200 and not a 404: a brand with no roadmap has an empty array rather than a missing file.
   * The preview lists these down its sidebar and reads each month's sheet through `roadmapSheet`.
   */
  roadmapMonths: (slug: string, signal?: AbortSignal) =>
    request<RoadmapMonthsResponse>(`/api/clients/${slug}/roadmap/months`, { signal }),

  /**
   * Removes ONE month's roadmap.csv and NOTHING else: blogs already written stay on disk and the
   * ledger still records them. `month` is required now that a brand holds many. 204, so there is
   * no body to hand back and the caller drops its copy.
   */
  deleteRoadmap: (slug: string, month: number) =>
    request<null>(`/api/clients/${slug}/roadmap?month=${month}`, { method: "DELETE" }),

  /**
   * Starts ONE agent session that researches the brand and writes its roadmap.csv, and answers
   * 202 in single digit milliseconds. The job it hands back is a record, not a promise: the
   * work runs in the engine's own background task, so nothing in this browser is holding it up
   * and closing the tab does not stop it.
   *
   * It adds the next month rather than replacing, so an existing roadmap is no longer a refusal.
   * The 409s that remain are worth reading: a blog run is live for this brand (a sheet must not
   * change under it), or a generation is already running. 422 bounds the inputs.
   */
  generateRoadmap: (slug: string, body: GenerateRoadmapBody) =>
    request<RoadmapGenJob>(`/api/clients/${slug}/roadmap/generate`, {
      method: "POST",
      body,
    }),

  /**
   * The brand's generation job, running or settled. THE authority on it: a browser that was
   * not open when the job started reads it here and shows it exactly as the one that was.
   * 404 means this brand has never had a generation, which is an empty state and not an error.
   */
  roadmapGeneration: (slug: string, signal?: AbortSignal) =>
    request<RoadmapGenJob>(`/api/clients/${slug}/roadmap/generate`, { signal }),

  /**
   * Forgets a SETTLED job, so its report stops being the answer to "what happened here". 409
   * while it runs, because a job in flight is not the operator's to forget. 204, so there is
   * no body and the caller drops its copy.
   */
  clearRoadmapGeneration: (slug: string) =>
    request<null>(`/api/clients/${slug}/roadmap/generate`, { method: "DELETE" }),

  /**
   * The brand's canonical-facts.md, as text. 404 means the brand has no fact base yet, which is
   * the empty state `has_canonical_facts` reports and not an error.
   *
   * Read only, and there is no writer beside it on purpose: the file is binding for every blog
   * this brand ever ships, so it is reviewed and edited on disk by a human. This endpoint exists
   * so an operator can SEE what a draft was written against without opening a terminal.
   */
  facts: (slug: string, signal?: AbortSignal) =>
    requestText(`/api/clients/${slug}/facts`, signal),

  /**
   * The brand's canonical-facts.md build, running or settled. 404 means the engine has never
   * built one for this brand, which is an empty state and not an error.
   *
   * There is no POST here on purpose. A blog run starts this build, so a button that also
   * started one would be a second way to do the same thing, and the two could disagree about
   * whether a brand's fact base is being written.
   */
  factsGeneration: (slug: string, signal?: AbortSignal) =>
    request<FactsGenJob>(`/api/clients/${slug}/facts/generate`, { signal }),

  /**
   * Forgets a SETTLED build. 409 while it runs, because a build in flight is not the
   * operator's to forget: the blog run behind it is waiting on the file. 204, so there is no
   * body and the caller drops its copy.
   */
  clearFactsGeneration: (slug: string) =>
    request<null>(`/api/clients/${slug}/facts/generate`, { method: "DELETE" }),

  generate: (slug: string, body: GenerateBody) =>
    request<GenerateAccepted>(`/api/clients/${slug}/generate`, { method: "POST", body }),

  runs: (signal?: AbortSignal) => request<RunsResponse>("/api/runs", { signal }),

  /**
   * Stops every live run for ONE brand, and deletes nothing.
   *
   * This is the one cancel in this app, and it reverses the policy every other DELETE here
   * states: a describe job, a roadmap generation and a facts build are all left to land because
   * the session is already spending quota. A blog run is different only in size. It is minutes
   * of sessions rather than one, so "let it land and discard the result" means watching the
   * engine spend an hour on work the operator has already decided against.
   *
   * What the engine does with it, in the operator's terms: blogs already finished are KEPT, on
   * disk and in the ledger; blogs in flight are marked stopped and never ship; queued topics
   * never start. Nothing is deleted, which is the whole reason a stop is safe to press: a
   * stopped topic keeps its dossier and whatever draft it had, so generating it again resumes
   * from real work rather than from nothing.
   *
   * Brand-scoped, never run-scoped, because a brand can hold several live sessions at once and
   * a per-run stop would have the operator press it once per session while the queue moved
   * underneath them. Idempotent: stopping a brand that has already stopped is a 200 and a no-op.
   */
  stopRuns: (slug: string) =>
    request<StopRunsResult>(`/api/clients/${slug}/runs`, { method: "DELETE" }),

  /**
   * The SSE endpoint, for an EventSource. Not fetched here. EventSource cannot set headers,
   * so this is the ONE route where the token travels as a query parameter (the engine
   * accepts both there, header winning). It is read synchronously because an EventSource is
   * constructed synchronously; the background refresh timer keeps the stored token live, so
   * the copy read here is never stale by more than its cadence.
   */
  eventsUrl: (runId: string) => {
    const base = url(`/api/runs/${runId}/events`);
    const token = getAccessToken();
    return token === null ? base : `${base}?access_token=${encodeURIComponent(token)}`;
  },

  blogs: (slug: string, signal?: AbortSignal) =>
    request<BlogsResponse>(`/api/clients/${slug}/blogs`, { signal }),

  output: (slug: string, topicSlug: string, name: OutputFile, signal?: AbortSignal) =>
    requestText(`/api/clients/${slug}/output/${topicSlug}/${name}`, signal),

  /**
   * The evaluator's questions for one blog, decorated with `stale`, `blocking` and `answered`.
   *
   * 404 is the EMPTY STATE and not an error: most blogs are written without the evaluator ever
   * needing a human, so most topics have no questions.json and every caller here treats that
   * answer as "nothing to ask".
   */
  blogQuestions: (slug: string, topicSlug: string, signal?: AbortSignal) =>
    request<BlogQuestions>(`/api/clients/${slug}/blogs/${topicSlug}/questions`, { signal }),

  /**
   * Files the operator's answers and starts the surgical revise that uses them. 202, and what
   * comes back is the RUN, not a result: the revise is an engine session that takes minutes, so
   * the browser starts it and then watches the run list exactly as it watches every other job.
   *
   * Its refusals are all worth reading rather than retrying: 422 names the ids left blank, and
   * 409 means either a session is already live for this brand or the questions are stale, which
   * is the engine refusing to feed notes about a superseded draft into a revise of a live one.
   */
  answerQuestions: (slug: string, topicSlug: string, body: AnswersBody) =>
    request<RunSummary>(`/api/clients/${slug}/blogs/${topicSlug}/answers`, {
      method: "POST",
      body,
    }),

  /**
   * Dispatches the answer-driven revise a CLIENT-answered form is owed. The portal records a
   * client's answers with no engine behind it, so nothing ran at their submit time; this is
   * the operator choosing the moment this machine's quota is spent. 202 with the run, exactly
   * like answerQuestions. 409 means demo, stale, unanswered, a live brand session, or another
   * machine's engine already mid-rerun on this topic; each detail says which.
   */
  reviseBlog: (slug: string, topicSlug: string) =>
    request<RunSummary>(`/api/clients/${slug}/blogs/${topicSlug}/revise`, {
      method: "POST",
    }),

  /**
   * One blog's selection comments as THREADS: every top-level comment with its replies
   * nested under it, oldest first, dismissed ones included so the caller decides what to
   * show. Engine-only: the hosted build never calls this, because an apply is a session
   * only the local engine can run.
   */
  blogComments: (slug: string, topicSlug: string, signal?: AbortSignal) =>
    request<BlogCommentsResponse>(
      `/api/clients/${slug}/blogs/${topicSlug}/comments`,
      { signal },
    ),

  /**
   * Files one selection comment and starts the Claude session that applies it. 202 with
   * the comment already in state "applying": the apply takes tens of seconds, so the
   * browser polls the comment list rather than holding this request open. 409s worth
   * reading rather than retrying: demo brand, a blog that is not done, a live run, or
   * three changes already in flight.
   */
  addBlogComment: (slug: string, topicSlug: string, body: AddCommentBody) =>
    request<BlogComment>(`/api/clients/${slug}/blogs/${topicSlug}/comments`, {
      method: "POST",
      body,
    }),

  /**
   * Dismisses one comment: state flips to "dismissed" and the record stays, because a
   * client's suggestion is part of the review trail even when the team declines it. 204,
   * and 409 while the comment is still applying. Works for either author's comments.
   */
  deleteBlogComment: (slug: string, topicSlug: string, commentId: string) =>
    request<null>(
      `/api/clients/${slug}/blogs/${topicSlug}/comments/${encodeURIComponent(commentId)}`,
      { method: "DELETE" },
    ),

  /**
   * Starts the Claude apply for one open or failed comment: the Resolve with Claude button
   * on a client suggestion, and the retry on a failed apply of either author's. 202 with
   * the comment already flipped to "applying", so the poll takes over exactly as it does
   * after addBlogComment. 409s worth reading rather than retrying: wrong state, a live
   * run, a demo brand, or three changes already in flight.
   */
  resolveBlogComment: (slug: string, topicSlug: string, commentId: string) =>
    request<BlogComment>(
      `/api/clients/${slug}/blogs/${topicSlug}/comments/${encodeURIComponent(commentId)}/resolve`,
      { method: "POST" },
    ),

  /**
   * Reframes one comment as a standing instruction for every future blog and appends it to
   * the brand's custom instructions. The engine runs the reframe (a one-shot Claude call),
   * performs the append, and stamps the comment, so the act is idempotent: a comment already
   * added answers with its existing state rather than a second line. Returns the reframed
   * instruction for the toast.
   */
  commentToInstructions: (slug: string, topicSlug: string, commentId: string) =>
    request<{ instruction: string }>(
      `/api/clients/${slug}/blogs/${topicSlug}/comments/${encodeURIComponent(commentId)}/to-instructions`,
      { method: "POST" },
    ),

  /**
   * Where one blog sits in the client review loop: sent, approved, and how many client
   * suggestions are still open. The stage page reads this beside the summary so a resolve
   * or a dismiss can refresh the delivery chip without refetching the whole blogs list.
   */
  blogReview: (slug: string, topicSlug: string, signal?: AbortSignal) =>
    request<BlogReviewState>(`/api/clients/${slug}/blogs/${topicSlug}/review`, { signal }),

  /**
   * Saves the operator's own edit of blog.md. Synchronous on purpose: the write plus the
   * record commit is subsecond, and Save should not release until the edit is durable.
   * The engine 409s anything not done, a demo brand, and a live run.
   */
  /**
   * Saves the operator's own edit as a new committed version.
   *
   * `baseVersion` is the version number the editor was opened on, and it travels because the
   * HOSTED build has no APPLY_LOCK and no engine holding anything: admin_save_blog_content
   * refuses a save whose base no longer matches, so two operators editing one article get a
   * refusal instead of one of them silently burying the other. The local engine ignores it and
   * relies on the lock, so sending it costs nothing there and is the whole guard here.
   */
  saveBlogContent: (
    slug: string,
    topicSlug: string,
    blogBody: string,
    baseVersion: number | null,
  ) =>
    request<SaveContentResult>(`/api/clients/${slug}/blogs/${topicSlug}/content`, {
      method: "POST",
      body: { body: blogBody, base_version: baseVersion },
    }),

  /**
   * Puts an article the operator already has into admin review, in place of generating one.
   *
   * The article travels as TEXT IN JSON, not as multipart, even though the operator picked
   * a file: the browser reads the file and sends its contents, which is what every other
   * body-carrying route here does and what saveBlogContent above already does with the very
   * same field. A markdown article is text by definition, so the multipart machinery would
   * buy nothing and cost a second content type on the engine.
   *
   * The topic slug is the whole of what identifies the piece. The engine re-reads the title,
   * scope and target prompts from this brand's roadmap itself, so a stale tab cannot file an
   * article against a topic that no longer exists or relabel one that does.
   *
   * 404 when no roadmap row matches the slug, 409 when the topic already has a blog and
   * `replace` was not set, 409 while a run is live or the client has open suggestions, 422 on
   * an empty file, 413 over 1 MB. The gate report in the result is ADVISORY: a failing gate
   * does not refuse the upload, so read it and show it rather than treating it as an error.
   */
  uploadBlog: (slug: string, topicSlug: string, blogBody: string, replace: boolean) =>
    request<UploadBlogResult>(`/api/clients/${slug}/blogs/${topicSlug}/upload`, {
      method: "POST",
      body: { body: blogBody, replace },
    }),

  /**
   * Uploads a Word .docx instead of markdown. The engine converts the body and turns each
   * tracked Word comment into an OPEN change request on its passage, so the review rail shows
   * them with a Resolve with Claude button. Multipart because the payload is a binary file;
   * `replace` rides as a query param for the same reason. Same result shape as uploadBlog plus
   * `comments_added`. Local engine only (Vercel has no converter), like uploadBlog.
   */
  uploadBlogDocx: (slug: string, topicSlug: string, file: File, replace: boolean) => {
    const form = new FormData();
    form.append("file", file);
    return request<UploadBlogResult>(
      `/api/clients/${slug}/blogs/${topicSlug}/upload-docx?replace=${replace ? "true" : "false"}`,
      { method: "POST", form },
    );
  },

  /**
   * Deletes one blog: soft-deletes the topic and drops its scratch, which clears it from the
   * library and re-frees its roadmap row for regeneration. 409 while a run is live. Idempotent
   * 204 on an unknown or already-deleted topic. Local engine only.
   */
  deleteBlog: (slug: string, topicSlug: string) =>
    request<void>(`/api/clients/${slug}/blogs/${topicSlug}`, { method: "DELETE" }),

  /**
   * Releases one shipped blog to the client portal, or releases it AGAIN after the client's
   * suggestions were resolved. Every call re-stamps the send and clears any approval,
   * because the client is approving an exact article and a re-send replaces it. 409 while
   * any client suggestion is still open: resolve or dismiss each one first, and the detail
   * says so in the engine's own words. Answers with the new review state.
   */
  sendBlogToClient: (slug: string, topicSlug: string) =>
    request<BlogReviewState>(`/api/clients/${slug}/blogs/${topicSlug}/send`, {
      method: "POST",
    }),

  /**
   * Ships a FAILED blog on the operator's authority and sends it to the client, one act.
   * The engine appends a `done` verdict naming the operator and the score, records the
   * ledger row (the roadmap locks the topic exactly as a 95+ ship would), and releases the
   * blog through the same send every shipped blog uses. 409 unless the topic is terminal
   * `failed` with an evaluator-scored committed draft and no live run holds it. Answers
   * with the new review state.
   */
  promoteBlog: (slug: string, topicSlug: string) =>
    request<BlogReviewState>(`/api/clients/${slug}/blogs/${topicSlug}/promote`, {
      method: "POST",
    }),

  /**
   * Pushes one shipped blog to the Strategi CMS as a draft for a human to review.
   *
   * The browser sends a brand and a topic and NOTHING ELSE: no title, no body, no key. The
   * engine reads the blog off its own disk, refuses anything that is not `done`, and holds
   * the write key server-side. A payload built here would be a payload a stale tab could
   * lie about, and the key would be in the bundle.
   *
   * 409 means the engine refused the blog's state (needs_review, running, failed) and the
   * detail names it. 503 means no key is configured for the org. 502 carries the CMS's own
   * words. No retry here: client.py already exhausted the retryable ones.
   */
  publishBlog: (slug: string, topicSlug: string) =>
    request<PublishResult>(`/api/clients/${slug}/blogs/${topicSlug}/publish`, {
      method: "POST",
    }),

  /**
   * Every month of reports this brand holds, plus the current month even when it has no report
   * yet, newest first. Each entry carries the WORKING report the operator owns and its
   * shared-with-client state. The dashboard draws its KPIs from the selected month and its
   * trend line from the metrics across all of them. Never a 404: an empty brand is an empty
   * `reports` array under the current month.
   */
  reports: (slug: string, signal?: AbortSignal) =>
    request<ReportsResponse>(`/api/clients/${slug}/reports`, { signal }),

  /**
   * Starts this month's report generation and answers 202 with the JOB. Generation always
   * targets the engine's current calendar month, so this takes no month. 409 when one is
   * already running, a blog run is live, or a report for this month already exists (delete it
   * first to regenerate). 422 when the brand has no domain to audit.
   */
  generateReport: (slug: string) =>
    request<ReportGenJob>(`/api/clients/${slug}/reports/generate`, { method: "POST" }),

  /** The brand's report generation job, running or settled, or 404 when there has never been one. */
  reportGeneration: (slug: string, signal?: AbortSignal) =>
    request<ReportGenJob>(`/api/clients/${slug}/reports/generate`, { signal }),

  /** Forgets a SETTLED generation job. 409 while it runs. 204, so the caller drops its copy. */
  clearReportGeneration: (slug: string) =>
    request<null>(`/api/clients/${slug}/reports/generate`, { method: "DELETE" }),

  /**
   * Sends one month's working report to the client: copies it into the shared snapshot the
   * portal reads. Every call re-shares (also after a regenerate). 409 when there is no
   * generated report for that month to share. Returns the new shared state.
   */
  shareReport: (slug: string, month: string) =>
    request<ShareReportResult>(`/api/clients/${slug}/reports/${month}/share`, { method: "POST" }),

  /**
   * Deletes one month's WORKING report and NOTHING the client sees: the shared snapshot
   * survives, so a client keeps seeing the last report sent. There is no way to see the working
   * copy again, so the caller confirms first. 204, and the caller reloads the list.
   */
  deleteReport: (slug: string, month: string) =>
    request<null>(`/api/clients/${slug}/reports/${month}`, { method: "DELETE" }),

  /** One month's report PDF, as a download blob. Needs the live engine. */
  reportPdf: (slug: string, month: string, signal?: AbortSignal) =>
    requestBlob(`/api/clients/${slug}/reports/${month}/pdf`, signal),

  /**
   * Every month of analyses this brand holds, plus the current month even when it has none yet,
   * newest first. Each entry carries the WORKING analysis document the dashboard draws its metrics
   * and trend from. Never a 404: an empty brand is an empty `analyses` array under the current month.
   */
  analysis: (slug: string, signal?: AbortSignal) =>
    request<AnalysisResponse>(`/api/clients/${slug}/analysis`, { signal }),

  /**
   * Runs this month's analysis and answers 202 with the JOB. Always targets the engine's current
   * calendar month, so it takes no month. 409 when one is already running, a blog run is live, or an
   * analysis for this month already exists (delete it first). 422 when the brand has no domain.
   */
  generateAnalysis: (slug: string) =>
    request<AnalysisGenJob>(`/api/clients/${slug}/analysis/generate`, { method: "POST" }),

  /** The brand's analysis job, running or settled, or 404 when there has never been one. */
  analysisGeneration: (slug: string, signal?: AbortSignal) =>
    request<AnalysisGenJob>(`/api/clients/${slug}/analysis/generate`, { signal }),

  /** Forgets a SETTLED analysis job. 409 while it runs. 204, so the caller drops its copy. */
  clearAnalysisGeneration: (slug: string) =>
    request<null>(`/api/clients/${slug}/analysis/generate`, { method: "DELETE" }),

  /** Deletes one month's WORKING analysis. 204, and the caller reloads the list. */
  deleteAnalysis: (slug: string, month: string) =>
    request<null>(`/api/clients/${slug}/analysis/${month}`, { method: "DELETE" }),

  /** One month's analysis PDF, as a download blob. Needs the live engine. */
  analysisPdf: (slug: string, month: string, signal?: AbortSignal) =>
    requestBlob(`/api/clients/${slug}/analysis/${month}/pdf`, signal),

  /**
   * The running desktop app's version. Engine-only, so the Settings panel that reads it is hidden
   * on the hosted build (there is no app to version there). 'dev' for a source checkout.
   */
  appVersion: (signal?: AbortSignal) =>
    request<AppVersion>("/api/app/version", { signal }),

  /** Whether a newer app package exists in the releases bucket. Never rejects on a network miss:
   * the engine answers update_available false with a note the panel shows. Admin-only. */
  checkAppUpdate: (signal?: AbortSignal) =>
    request<AppUpdateCheck>("/api/app/update/check", { signal }),

  /**
   * Downloads and STAGES the newest package; it applies on the next restart, so the result says
   * restart_required. 400 with a reason when there is no update or the download fails. Admin-only.
   */
  updateApp: () => request<AppUpdateResult>("/api/app/update", { method: "POST" }),
};

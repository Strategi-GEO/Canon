/**
 * The FastAPI contract at NEXT_PUBLIC_API_BASE. These types mirror the server's shapes
 * exactly, including its error bodies: a page can only show an operator the real reason a
 * request failed if the reason survives the type layer intact.
 */

export type Preflight = {
  ok: boolean;
  reason: string;
};

/**
 * The org a brand belongs to, as gates.json records it under its optional "organisation"
 * key. Optional on the wire: a client without the key is its own single-brand org, which
 * the engine resolves for us. Reading it off a Client is therefore a hint, never the
 * authority, and the authority is the grouping GET /api/orgs returns.
 */
export type Organisation = {
  slug: string;
  name: string;
};

export type Client = {
  slug: string;
  name: string;
  /**
   * Present on GET /api/clients, and NOT sent by GET /api/orgs, which returns brands
   * undecorated. lib/orgs-context fills it in from the client list before any brand reaches a
   * component, so every brand read through useOrgs carries it. Do not fetch a brand from
   * /api/orgs directly and trust this field.
   */
  preflight: Preflight;
  description: string;
  /**
   * The operator's standing blog instructions for this brand, edited from Settings and obeyed
   * by the generation agents as a major priority. Operator material: the engine's own record
   * carries it, and the hosted read-only mirror does NOT (that read never selects the column),
   * so it can be "" there. Absent-safe with `?? ""` at every read.
   */
  custom_instructions: string;
  /**
   * The CMS's own routing slug for this brand, edited in Settings. The publish payload routes a
   * draft to the CMS by this when set, else by the brand slug. Operator material like
   * custom_instructions: the hosted mirror never selects it, so it can be "" there. Absent-safe
   * with `?? ""` at every read.
   */
  cms_client: string;
  domain: string;
  industry: string;
  /**
   * Geography + language, e.g. "India, English": what DataForSEO validates keywords against
   * and whose local sources the researcher prefers. Asked at onboarding, edited in Settings.
   * Absent-safe with `?? ""` at every read, like custom_instructions.
   */
  market: string;
  has_roadmap: boolean;
  has_canonical_facts: boolean;
  resource_count: number;
  blog_count: number;
  organisation?: Organisation | null;
};

/**
 * An org is a GROUPING over brands, derived by the engine from each client's gates.json.
 * There is no orgs/ directory and no second config file, so this can never drift out of
 * sync with the clients it groups.
 *
 * The brand stays the engine's unit of work: one brand owns exactly one canonical-facts.md
 * and one roadmap. An org owns none of those, so nothing here is ever a place to read facts
 * from.
 */
export type Org = {
  slug: string;
  name: string;
  brands: Client[];
};

export type OrgsResponse = {
  orgs: Org[];
};

export type ClientsResponse = {
  clients: Client[];
};

export type IndustriesResponse = {
  industries: string[];
};

/**
 * GET /api/me: who this token is to the app. The shell reads exactly one bit of it,
 * is_admin, because THIS CONSOLE IS FOR THE STRATEGI TEAM: a client login (an org grant
 * without the admin bit) is refused at the door and sent to their Client Portal, where
 * the same credential works. The scoping fields ride along for completeness; nothing in
 * the dashboard branches on them.
 */
export type MeResponse = {
  user_id: string;
  email: string;
  is_admin: boolean;
  orgs: Organisation[];
  clients: string[];
};

/** The running desktop app's version ('dev' for a source checkout). */
export type AppVersion = {
  version: string;
};

/** Whether a newer app package exists. `notes` carries the reason when none does (up to date,
 *  dev checkout, or a network miss), so the Settings panel always has something to show.
 *  `runs_active` disables the button: updating restarts the app, which would kill a live run. */
export type AppUpdateCheck = {
  current: string;
  latest: string | null;
  update_available: boolean;
  notes: string;
  runs_active: boolean;
};

/** The result of staging an update: it is downloaded, and the app restarts itself to apply it. */
export type AppUpdateResult = {
  ok: boolean;
  staged_version: string;
  restart_required: boolean;
  restarting: boolean;
};

export type CreateClientBody = {
  name: string;
  domain: string;
  industry: string;
  /**
   * Geography + language ("India, English"). Asked at onboarding because DataForSEO keyword
   * validation is silently skipped on every run for a brand without one.
   */
  market?: string;
  description?: string;
  /**
   * The org to file this brand under, by NAME rather than slug: the operator can type a new
   * org here, and the engine slugifies and matches. Omitted means the brand is its own
   * single-brand org.
   */
  organisation_name?: string;
  /**
   * The brand's standing blog instructions. Optional on create; the real editing surface is
   * Settings, which PATCHes it through UpdateClientBody. Empty string clears it; omitted means
   * "not sent" and leaves the record alone.
   */
  custom_instructions?: string;
  /**
   * The CMS's own routing slug for this brand. Settings-only, like custom_instructions: never
   * collected at create, but modelled here so UpdateClientBody (a Partial of this) can PATCH it.
   * Empty string clears it and the payload falls back to the brand slug; omitted means "not sent".
   */
  cms_client?: string;
};

export type UpdateClientBody = Partial<CreateClientBody>;

/**
 * The client portal login minted when a brand's organisation gets its first login. Returned by
 * POST /api/clients ONCE, in the create response, and never again: the password cannot be read
 * back from the auth store, so the create dialog shows it for the admin to save and the durable
 * copy lives only in the engine's local .env.portal-credentials file.
 */
export type PortalCredential = {
  email: string;
  password: string;
};

/**
 * What POST /api/clients actually returns: the created brand, plus the one-time portal login
 * when this create minted one. `portal_login` is null when the brand joined an org that already
 * had a login, or when provisioning could not run (the brand is still created either way).
 */
export type CreateClientResult = Client & {
  portal_login?: PortalCredential | null;
};

/**
 * One brand's description draft, as the engine actually holds it.
 *
 * A JOB rather than an answer, because the engine owns the work and the browser only watches:
 * POST starts a session and returns THIS immediately with `state: "running"`, and the draft
 * lands in it tens of seconds later. This type used to describe the answer alone, which made
 * every reader of the POST believe a field that is null at that instant.
 *
 * Keyed by brand slug server side, so one brand can have exactly one draft in flight. A second
 * POST for the same brand returns the job already running rather than starting a rival.
 */
export type DescribeJob = {
  /** The BRAND slug the engine keys the job by. A key, never a label. */
  client: string;
  state: DescribeState;
  started: string;
  /** Null while running. Set the instant the session settles, either way. */
  finished: string | null;
  /**
   * NULL while running, and null is a real value on the wire rather than a defensive guess.
   * Never coerce it to "": an empty description is a description, and an unfinished one is not.
   */
  description: string | null;
  /** The pages the session actually read. Always the homepage, never parsed from its prose. */
  sources: string[];
  /** The engine's own words when the session died, or null. Never flattened to "". */
  error: string | null;
};

export type DescribeState = "running" | "done" | "failed";

/** Every draft job the engine still holds, live or settled. The mirror of RunsResponse. */
export type DescribeJobsResponse = {
  jobs: DescribeJob[];
};

export type Resource = {
  name: string;
  size: number;
  modified: string;
  /**
   * The MIME type the engine recorded at upload, e.g. "application/pdf". Optional on the
   * wire: an engine build predating the field, or a file dropped into Resources/ by hand,
   * sends nothing, and the UI then falls back to the filename extension.
   */
  content_type?: string;
};

export type ResourcesResponse = {
  resources: Resource[];
};

/** What the engine already shipped for this topic, or null if it never has. */
export type RoadmapLedger = {
  score: number;
  generated_at: string;
};

export type RoadmapRow = {
  index: number;
  topic: string;
  covers: string;
  prompts: string[];
  topic_slug: string;
  complete: boolean;
  missing: string[];
  already_generated: boolean;
  ledger: RoadmapLedger | null;
};

export type RoadmapResponse = {
  columns: string[];
  upload_id: string;
  archived: string | null;
  rows: RoadmapRow[];
  warnings: string[];
  /**
   * Which month this roadmap is, 1-based. A brand now holds many roadmaps, one per month, and an
   * upload or generate response says which month it just created. Optional on the wire: a plain
   * GET /roadmap of the latest month need not carry it, and an older engine build sends nothing.
   */
  month?: number;
};

/**
 * The roadmap CSV as a sheet: the file itself, not the engine's reading of it.
 *
 * RoadmapResponse is the three columns the factory acts on, already parsed into topics. This
 * is every column the operator's sheet actually holds, which is the only way a preview can
 * show what is in the file AND show which of it the engine ignores. The two are different
 * questions about one file, so they are different shapes rather than one shape doing both.
 *
 * The header and every row arrive padded to the same width, so this is always a rectangle and
 * the browser never has to pad a ragged CSV itself. A cell the file omitted is "".
 */
export type RoadmapSheet = {
  filename: string;
  /** UTC ISO 8601, like every timestamp the engine writes. */
  modified: string;
  bytes: number;
  /** The header row, padded to the sheet's width. */
  columns: string[];
  /** The data rows, each padded to the same width as `columns`. */
  rows: string[][];
};

/**
 * One month's roadmap in the brand's list, as GET /roadmap/months returns it. A brand used to
 * hold one roadmap and now holds many, one per month, and this is the index the preview lists
 * down its sidebar. `label` is the operator-facing name ("Month N Roadmap"); `month` is the
 * 1-based sequence key every other roadmap endpoint takes as ?month=N.
 */
export type RoadmapMonth = {
  month: number;
  label: string;
  filename: string;
  /** UTC ISO 8601, like every timestamp the engine writes. */
  modified: string;
  row_count: number;
};

/**
 * Every month's roadmap this brand holds, month ASCENDING. Unlike a single-roadmap read, an
 * EMPTY array is a 200 and not a 404: a brand with no roadmap has an empty list rather than a
 * missing resource, so the preview reverses this for newest-first display and closes on empty.
 */
export type RoadmapMonthsResponse = {
  months: RoadmapMonth[];
};

/**
 * What POST /api/clients/{slug}/roadmap/generate takes.
 *
 * `notes` is always sent, as "" when the operator left it blank, because the prompt
 * substitutes it either way and an absent key and an empty one would be two ways to say the
 * same thing.
 */
export type GenerateRoadmapBody = {
  brand_url: string;
  piece_count: number;
  notes: string;
};

/**
 * What POST /api/clients/{slug}/roadmap/rewrite takes. No brand_url and no piece count: the
 * site comes off the brand's own record, and the total is fixed by design, one replacement
 * per ticked row. `feedback` is always sent, "" when the operator left it blank, for the
 * same one-way-to-say-it reason notes is.
 */
export type RewriteRoadmapBody = {
  /** 0-based sheet indices, the same numbering RoadmapRow.index carries. */
  row_indices: number[];
  feedback: string;
};

/**
 * One rewrite batch, as the engine remembers it. UNLIKE the generation job there are MANY of
 * these per brand at once, keyed by `id`: the operator's loop is "reject rows 3 and 7, and
 * while that runs, reject row 5 with different feedback". Each batch owns its rows outright
 * (the engine refuses an overlap), so per-row state in the sheet comes from unioning the
 * running batches' row_indices. Same durability rules as RoadmapGenJob: engine timestamps,
 * survives refresh, no percentage possible.
 */
export type RewriteJob = {
  /** The job's own key, for dismissing it once its report is read. */
  id: string;
  /** The BRAND slug. A key, never a label. */
  client: string;
  state: RoadmapGenJobState;
  /** UTC ISO 8601, from the engine. Every elapsed clock measures from this and nothing else. */
  started: string;
  /** Null while running. */
  finished: string | null;
  /** The 0-based sheet indices this batch is replacing, echoed back. */
  row_indices: number[];
  /** The operator's feedback, echoed back. "" when they gave none. */
  notes: string;
  /** The agent's FINAL message: what it planned and what it disputes. Null while running. */
  report: string | null;
  /** Rows actually replaced, set only when the splice landed. Null otherwise. */
  rows: number | null;
  /** The engine's own sentence when state is "failed". Shown verbatim, never paraphrased. */
  error: string | null;
};

/**
 * "running" is the only non terminal value, and it is the ONLY thing that may put a clock on
 * screen. Both settled values are final: the engine never reopens a job.
 */
export type RoadmapGenJobState = "running" | "done" | "failed";

/**
 * One roadmap generation, as the engine remembers it.
 *
 * This job lives in the ENGINE, not in this tab. The POST returns it in single digit
 * milliseconds and the work carries on in a background task, so a refresh, a second tab, or a
 * different operator all read the same job from GET and see the same elapsed: `started` is the
 * engine's own timestamp, and every clock in this app measures from it rather than from the
 * moment a browser happened to notice.
 *
 * There is NO percentage here and there never can be one. A generation is a single agent
 * session making an unknown number of tool calls, so nothing on the wire could give a bar a
 * denominator. `started` is the honest number and it is the one the UI shows.
 */
export type RoadmapGenJob = {
  /** The BRAND slug. A key, never a label. */
  client: string;
  state: RoadmapGenJobState;
  /** UTC ISO 8601, from the engine. Every elapsed clock measures from this and nothing else. */
  started: string;
  /** Null while running. */
  finished: string | null;
  /** The inputs, echoed back, so a job read after a refresh still says what it was asked for. */
  brand_url: string;
  piece_count: number;
  notes: string;
  /**
   * The agent's FINAL message: what it pulled, what it cut, and what it disputes, including
   * rows it refused to plan because canonical-facts.md forbids the claim. Null while running.
   * It is the most valuable output besides the CSV, so it is rendered rather than summarised.
   */
  report: string | null;
  /** Rows in the roadmap it wrote, counted by re-parsing the file. Null unless it wrote one. */
  rows: number | null;
  /** The engine's own sentence when state is "failed". Shown verbatim, never paraphrased. */
  error: string | null;
};

/**
 * The states a canonical-facts.md build can be in. The same three the other engine jobs use,
 * and for the same reason: "running" is the only non terminal one, so it is the only one that
 * may put a clock on screen.
 */
export type FactsGenJobState = "running" | "done" | "failed";

/**
 * One canonical-facts.md build, as the engine remembers it.
 *
 * NOTHING in the browser starts this. A blog run does: press Generate on a brand with no fact
 * base and the engine builds the file before it writes a single blog, because every blog for
 * that brand inherits it. There is deliberately no POST on this endpoint, so a second way to
 * start one cannot exist and disagree with the first.
 *
 * There is NO percentage here and there never can be one. A fact base is one agent session
 * reading resources and the live site through an unknown number of tool calls, so nothing on
 * the wire could give a bar a denominator. `started` is the honest number, and every clock
 * measures from it rather than from the moment a browser noticed.
 */
export type FactsGenJob = {
  /** The BRAND slug the engine keys the job by. A key, never a label. */
  client: string;
  state: FactsGenJobState;
  /** UTC ISO 8601, from the engine, so elapsed survives a refresh intact. */
  started: string;
  /** Null while running. Set the instant the session settles, either way. */
  finished: string | null;
  /** The agent's own account of what it read and what it could not. Null while running. */
  report: string | null;
  /** The engine's own sentence when state is "failed". Shown verbatim, never paraphrased. */
  error: string | null;
  /**
   * The blog run that triggered this build, so a view watching one run can tell whether the
   * build in front of it belongs to that run or to some earlier one. Null when the engine
   * holds a build no run owns.
   */
  run_id: string | null;
};

export type GenerateBody = {
  rows: number[];
  upload_id?: string;
  /**
   * Instructions specific to THIS run's blogs, typed in the dialog after Generate. Optional and
   * usually short or empty: the engine trims it, so a blank box behaves exactly as omitting it.
   */
  session_instructions?: string;
};

export type GenerateAccepted = {
  run_id: string;
  topics: string[];
};

export type DuplicateReason = "already_generated" | "in_flight";

/** The 409 body. Each entry names one row the server refused and why. */
export type Duplicate = {
  index: number;
  topic: string;
  topic_slug: string;
  reason: DuplicateReason;
  score: number | null;
  generated_at: string | null;
};

export type DuplicatesError = {
  detail: string;
  duplicates: Duplicate[];
};

/** The 422 body: detail is a list, one entry per incomplete row. */
export type IncompleteRow = {
  index: number;
  missing: string[];
};

export type IncompleteRowsError = {
  detail: IncompleteRow[];
};

/**
 * Where a run sits against the engine's CLIENT_LOCK, which admits ONE session at a time across
 * every brand. "queued" holds from the instant of POST until this run takes that lock, so a
 * session for one brand genuinely waits on a session for another. "finished" is terminal.
 *
 * "stopped" is terminal too, and it is deliberately NOT folded into "finished". The operator
 * pressed Stop, so the engine did no more work rather than running out of work to do. A stop
 * that reported "Session finished" would read as the stop having failed, and the operator would
 * press it again against a brand that had already halted. Both states end the clock and both
 * leave the queue; only one of them is something a person did.
 */
export type RunState = "queued" | "running" | "finished" | "stopped";

/**
 * One topic a run was accepted for, as the run list actually sends it.
 *
 * This was declared `string[]` and it never was: the wire has always carried objects. seedsFor
 * defends against both shapes because it is a boundary, but nothing else should have to.
 */
export type RunTopic = {
  index: number;
  topic_slug: string;
  tail_offset: number;
  /**
   * Repurpose runs only. `topic_slug` is the synthetic "<blog>/repurpose/<channel>" (the SSE
   * key); these two say which published blog and channel it belongs to, so a channel tab can
   * match a live run to a blog row. Absent on blog runs.
   */
  source_topic_slug?: string;
  channel?: RepurposeChannel;
};

export type RepurposeChannel = "linkedin" | "medium";

export type RepurposeBody = {
  topic_slug: string;
  channel: RepurposeChannel;
};

/** One generated channel artifact, from GET /api/clients/{slug}/repurpose/{topic}/{channel}. */
export type RepurposeArtifact = {
  content: string;
  generated_at: string;
  chars: number;
};

/** GET /api/clients/{slug}/repurpose?channel=... : the published blogs that already have a piece. */
export type RepurposeListing = {
  artifacts: Record<string, { generated_at: string; chars: number }>;
};

/**
 * One channel post's delivery state: the separate-track cousin of BlogState (server/channel.py).
 * Fewer states, because a repurpose has no score, no evaluator questions and no failure verdict,
 * so there is no has_questions / answers_submitted / failed here. `generating` is overlaid by the
 * UI from the live run feed and never stored; a technical generation failure surfaces the same way
 * a blog run's does, through the run status, so it is not a post state either.
 */
export type ChannelPostState =
  /** A repurpose run is live on this blog+channel (overlaid from the run feed, never on the wire). */
  | "generating"
  /** Generated, in internal admin review. The yellow "Created" tag. */
  | "created"
  /** Sent to the client: Ready to post on their side. */
  | "sent"
  /** The client asked for changes since the last send. */
  | "changes_requested"
  /** The client approved these exact bytes. */
  | "approved"
  /** The admin marked the piece live on the channel. The green "Posted" tag. */
  | "posted";

/**
 * One channel post, as GET /api/clients/{slug}/channel/{channel}[/{topic}] returns it. `content`
 * is present only on the single-post read; the list omits the body. Its comments reuse BlogComment
 * verbatim (same wire shape), so there is no ChannelComment type.
 */
export type ChannelPost = {
  id: string;
  /** The blog this piece was cut from, and its title. */
  source_topic_slug: string;
  source_topic: string;
  channel: RepurposeChannel;
  /** Never "generating" on the wire; the UI overlays that from the live run feed. */
  state: ChannelPostState;
  content?: string;
  created_at: string;
  updated_at: string;
  sent_to_client: string | null;
  client_approved: string | null;
  posted_at: string | null;
  /** Open + applying client suggestions, for the changes-requested count. */
  comments_pending: number;
  change_round_open: boolean;
};

export type ChannelPostsResponse = { posts: ChannelPost[] };

export type RunSummary = {
  run_id: string;
  /** The BRAND slug. It is a key, never a label: resolve it through useOrgs before rendering. */
  client: string;
  /**
   * SUBMIT time: the moment the operator pressed Generate. This is NOT when work began, and a
   * queued run can carry a `started` many minutes old with nothing whatsoever having happened.
   * Measuring "running for" from this is the headline lie this field invites.
   */
  started: string;
  live: boolean;
  state: RunState;
  /**
   * When this run took CLIENT_LOCK and work actually began. NULL while queued, which is the
   * whole reason it is separate from `started`: a running session's clock starts here, a
   * queued session has no such clock because nothing has run.
   */
  started_running: string | null;
  /**
   * Which half of a running run this is: "facts" while canonical-facts.md is being built,
   * "topics" once blogs are dispatched. Optional on the wire: an engine one restart behind
   * omits both, and every reader falls back to the old single clock.
   */
  phase?: "facts" | "topics" | null;
  /** When the CURRENT phase began. The blog clock measures from this when phase is "topics",
   *  so the facts build's minutes are never billed to the blogs. */
  phase_started?: string | null;
  topics: RunTopic[];
  /**
   * "blog" (a Create-Blogs run) or "repurpose" (a LinkedIn/Medium piece). Optional so an engine
   * one restart behind, which omits it, reads as "blog" and every existing reader is unchanged.
   */
  kind?: "blog" | "repurpose";
  /** The repurpose target, on repurpose runs only. Null/absent on blog runs. */
  channel?: RepurposeChannel | null;
};

export type RunsResponse = {
  runs: RunSummary[];
};

/**
 * What DELETE /api/clients/{slug}/runs did, which is always brand-scoped: the operator's choice
 * was "stop everything for that brand", so one press halts every live run they have, and there
 * is no per-run stop to race the queue with.
 *
 * NOTHING IN THIS APP RENDERS THESE FIELDS, on purpose. The stop is idempotent, so an honest
 * answer includes zero runs stopped, and a toast reading "0 runs stopped" over a brand that
 * genuinely halted would be worse than saying nothing. What changed on screen comes from the run
 * poll and the SSE stream, exactly as it does for every other mutation here, so this type
 * documents the contract rather than feeding a sentence.
 */
export type StopRunsResult = {
  runs_stopped: number;
  run_ids: string[];
};

export type Stage = "research" | "write" | "gates" | "links" | "eval" | "revise";

export type StageEvent = "start" | "end";

/**
 * "stopped" is written by the ENGINE and never by an agent: a stop kills the session, so the
 * session lead is not there to write its own last line and runner.py appends it for any topic
 * that had no terminal state yet. A topic that reached "done" microseconds before the stop
 * landed keeps its "done", which is the operator's own promise that finished blogs are kept.
 *
 * A STOPPED TOPIC IS NOT A FAILED ONE. Failed means the engine could not produce the blog.
 * Stopped means a person said don't, and nothing about the draft is being judged. Nothing in
 * this app may tint it red or count it among the failures.
 */
export type RunStatus = "running" | "done" | "needs_review" | "failed" | "stopped";

/**
 * One SSE "status" frame. Terminal state is read from `status`, never from `stage`: the
 * revise loop can revisit any stage, so a stage name says nothing about being finished.
 */
export type StatusEvent = {
  ts: string;
  slug: string;
  topic_slug: string;
  stage: Stage;
  event: StageEvent;
  iter: number;
  score: number | null;
  status: RunStatus;
  note: string;
};

/** The final SSE frame on the "run" event channel. */
export type RunEvent = {
  run_id: string;
  live: boolean;
};

/**
 * "unknown" is a real value on the wire, not a defensive guess. server/app.py builds a blog's
 * summary from status.jsonl and falls back to `summary.get("status") or "unknown"`, so a
 * topic holding a blog.md with no readable status line reports exactly that. An interrupted
 * run leaves one, and so does a file dropped into outputs/ by hand, which is supported here
 * because disk is the truth. Omitting it from this union does not stop the value arriving; it
 * only stops the compiler helping anyone handle it.
 *
 * `needs_review` is NOT A VERDICT, it is a WORKFLOW STATE, and it means exactly one thing: THIS
 * BLOG HAS QUESTIONS WAITING FOR THE OPERATOR THAT ARE CURRENT, ON DISK, AND ANSWERABLE. The
 * score is not part of that definition. A blog held at 96 has a verdict and the verdict is SHIP;
 * what it lacks is an answer, so it waits for a human rather than for a better draft. There is
 * deliberately NO second word for the held-and-passing case: one status, one meaning, and the
 * badge says which human act is owed rather than implying the draft is deficient.
 */
export type BlogStatus = "done" | "needs_review" | "failed" | "running" | "unknown" | "stopped";

export type BlogSummary = {
  topic: string;
  topic_slug: string;
  created: string;
  /** Null when no status line recorded one. Never coerce this to 0: 0 is a score. */
  score: number | null;
  /**
   * WHY THIS DRAFT DID NOT SHIP: the evaluator's own eval.md verdict and fix list, verbatim, so a
   * failed row can show its reason without opening the blog. NULL AT THE 95 SHIP BAR AND ABOVE and
   * null for an uploaded/unscored blog: a clean ship has no failure to explain. Admin-only, like
   * score and iterations, and the client wire never carries it (failed blogs are not client
   * visible anyway). Optional on the wire for the same engine-age reason as sent_to_client.
   */
  reason?: string | null;
  status: BlogStatus;
  /** Null on the same path that produces status "unknown": no status line, no count. */
  iterations: number | null;
  shipped: boolean;
  /**
   * Whether an operator handed this article to the app instead of the engine writing it.
   *
   * WHAT IT CHANGES FOR A READER: an uploaded blog has no evaluator score, no eval.md and no
   * dossier.md, and that is correct rather than broken. Without this flag the Eval and
   * Dossier tabs render their 404 as a red failure panel reading "a blog that stopped before
   * this stage never wrote the file", which is alarming and, for an upload, false. Surfaces
   * that mention a score or an artifact check this first.
   *
   * It does NOT change what the blog can do. An uploaded blog is `done`, so it edits,
   * comments, sends and publishes exactly like a generated one.
   *
   * Optional on the wire so a summary from an engine build predating the field reads as
   * generated rather than breaking, matching sent_to_client below.
   */
  uploaded?: boolean;
  /**
   * The latest COMMITTED version number, or null for a topic with no version yet.
   *
   * It exists for one job: the hosted editor sends it back as `base_version`, and
   * admin_save_blog_content refuses the save when it no longer matches. That is the whole
   * of what stops two operators on the hosted build from silently burying each other's
   * edits, because nothing there holds the APPLY_LOCK the local engine relies on.
   *
   * Optional on the wire for the same engine-age reason as sent_to_client: a summary from
   * a build predating the field reads as absent, and the editor refuses rather than
   * guessing a base version.
   */
  version_no?: number | null;
  /**
   * This blog's row on the CURRENT roadmap, or null when it sits on no row: the sheet was
   * deleted, or re-uploaded without this topic, or the blog was dropped into outputs/ by hand.
   *
   * ZERO BASED, exactly like RoadmapRow.index, and DISPLAYED AS index + 1. Both numbers describe
   * one row, so a second convention for it is how an off-by-one is born: the preview's "#" column
   * and engine-error.tsx both already display index + 1, and this agrees with them.
   *
   * Never coerce the null to 0. Zero is row one.
   */
  roadmap_index: number | null;
  /**
   * When an operator last pressed Send to client, UTC ISO, or null while the blog is still
   * the team's. A done blog with null here sits in ADMIN REVIEW: shipped, editable on the
   * blog stage page, and invisible to the client portal until the send. Every send re-stamps
   * this, so after a Send again it carries the latest release, not the first. Optional on
   * the wire so a summary from an engine build predating the field reads as unsent rather
   * than breaking.
   */
  sent_to_client?: string | null;
  /**
   * When the client approved the sent article from their portal, UTC ISO, or null. The
   * engine CLEARS this on every send, so a re-sent blog reads unapproved until the client
   * approves the new text: an approval describes one exact article, never the topic.
   * Optional on the wire for the same engine-age reason as sent_to_client.
   */
  client_approved?: string | null;
  /**
   * The client's suggested changes still owed a resolution: their comments in state open or
   * applying. Zero for a topic with no comments, and the engine refuses a re-send while it
   * is above zero. Optional on the wire for the same engine-age reason as sent_to_client.
   */
  changes_requested?: number;
  /**
   * The HUMAN-facing count: the same comments plus the failed applies, exactly as the
   * client's own comments_pending counts them (portal-data.ts). The changes_requested tag
   * splits "Changes requested" from "With client" on this number and never on the send-gate
   * count above, so a failed apply cannot read resolved to the admin while still pending to
   * the client. Optional on the wire for the same engine-age reason as sent_to_client.
   */
  comments_pending?: number;
  /**
   * Whether the client has asked for anything SINCE the last send. The round, not the queue.
   *
   * THE ROUND DECIDES THE STATE AND THE COUNT ABOVE DOES NOT, which is the opposite of how this
   * started and the reason the loop dead-ended: resolving the last suggestion took the count to
   * zero, dropped the article back to client_review, and took the admin's Send button with it,
   * so the fix they had just made could never reach the client. The round survives resolving,
   * dismissing and a failed apply, and only a re-send closes it. See lib/blog-state.ts.
   */
  change_round_open?: boolean;
  /**
   * When the client submitted answers to the CURRENT question form, UTC ISO, or null while
   * that form is still unanswered.
   *
   * A STAMP RATHER THAN A BOOLEAN, matching sent_to_client, client_approved and every other
   * field here that records a human act. A boolean answers "did they" and nothing else, where
   * a stamp answers "when", which is what a card renders under "Questions answered" without a
   * second call to the backend.
   *
   * IT IS THE FIELD THAT SEPARATES has_questions FROM answers_submitted in lib/blog-state.ts,
   * so an admin surface that cannot see it cannot tell an unanswered hold from an answered one
   * waiting on the operator's rerun. Both backends have sent it since that state machine
   * landed: the engine in server/app.py's blog listing, the hosted build in
   * app/api/clients/[slug]/blogs/route.ts. Only this type was missing it, and the effect was
   * quiet rather than loud, because blogState() takes BlogStateFacts, which declares the field
   * as optional. A BlogSummary handed to it therefore carried the value at runtime while the
   * compiler believed the property could not exist, so the derived state came out right by
   * luck rather than because the contract said so.
   *
   * Optional on the wire for the same engine-age reason as sent_to_client: a summary from a
   * build predating the field reads as unanswered rather than breaking.
   */
  answers_submitted?: string | null;
  /**
   * Whether a run owns this topic right now, from the engine's run registry.
   *
   * NOT DERIVABLE FROM `status`, which is why it is on the wire at all. The status fold reads
   * the last TERMINAL line of an append-only feed that outlives the run that wrote it, so a
   * second run on a topic reports the first run's outcome for its whole duration. Absent on the
   * hosted build, correctly: nothing runs there, so there is no registry to ask and the status
   * fallback in blogState is the honest answer.
   */
  live?: boolean;
  /**
   * When this article was last pushed to the CMS, UTC ISO, or null.
   *
   * NULL MEANS "NO RECORD OF A PUSH", NEVER "NOT PUBLISHED", and every surface reading this
   * field is bound by that. Migration 012 added the column with no backfill and said why:
   * nothing anywhere recorded the pushes that happened before it, so a stamp invented from
   * generated_at would assert a publish that may never have occurred. History starts at 012.
   * The rendering rule that falls out of it is absolute: state the positive fact where the
   * stamp exists and say NOTHING where it does not. No surface renders "not published".
   *
   * Optional on the wire for the same engine-age reason as sent_to_client.
   */
  published?: string | null;
  /**
   * The CMS's own word for this post, typically "draft" or "published", or null.
   *
   * It is the difference between an editor holding a draft and the article being live on the
   * site, and those two call for opposite actions from an operator. ALWAYS NULL ON THE HOSTED
   * BUILD: 012 granted only published_at to `authenticated`, so the hosted blogs route cannot
   * read this column and reports null rather than guessing. A null is therefore "we cannot
   * tell", never "draft", and it never licenses claiming the article is live: it settles on
   * the weaker sentence, that the push happened.
   *
   * Optional on the wire for the same engine-age reason as sent_to_client.
   */
  cms_status?: string | null;
};

export type BlogsResponse = {
  blogs: BlogSummary[];
};

/**
 * The four Areas .claude/questions.py validates against, and deliberately the same four the fix
 * list uses: an answer routes exactly like a fix does, Sourcing back to the researcher and the
 * rest to the writer.
 */
export type QuestionArea = "Sourcing" | "Structure" | "Draft" | "Mechanics";

/** One thing the evaluator could not settle by itself, as questions.py wrote it. */
export type BlogQuestion = {
  id: string;
  area: QuestionArea;
  question: string;
  /**
   * What answering it unblocks, in the evaluator's own words. NOT decoration: the operator is
   * deciding whether they are even the person who can answer, and questions.py refuses to write
   * a question without one, so this is never empty and is never worth hiding behind a toggle.
   */
  why: string;
};

/**
 * One blog's questions.json, decorated by the engine with the three facts a file on disk cannot
 * know about itself.
 *
 * OPEN QUESTIONS HOLD A BLOG AT ANY SCORE, and the score does not enter that decision. A 96 with
 * current questions is HELD, not shipped: answering is a DEMAND at every score, there is no
 * dismiss and no proceed-anyway. The old rule, which held a blog only below 95 and treated a
 * question on a passing draft as an offer, demonstrably shipped two canonical-facts violations at
 * 96, so a question the operator never answered went out as fact. That is what the hold exists to
 * stop.
 *
 * `blocking` is the ENGINE's own copy of that decision and it stays on the wire, but NOTHING in
 * this app branches on it any more. The hold is derived from the QUESTION STATE alone (see
 * questions-state.ts), which is the axis the rule now turns on and which `stale` and `answered`
 * already carry. Reading a score-shaped flag to decide a hold the score no longer governs is how
 * the old rule would grow back.
 *
 * `stale` means the questions describe an iteration this blog has already moved past. The file
 * is rewritten only when an evaluator asks, so an iteration-1 ask that a revise fixed leaves a
 * file describing a draft that no longer exists. The engine 409s a submission against one, and
 * a real blog under outputs/ is in exactly this state today. A stale ask summons nobody, so it
 * does not hold the blog.
 */
export type BlogQuestions = {
  slug: string;
  asked: string;
  iter: number;
  /** The score the eval that asked gave. Null when it recorded none. Never coerce it to 0. */
  score: number | null;
  questions: BlogQuestion[];
  stale: boolean;
  blocking: boolean;
  /**
   * True when an answers.json exists for this same iteration.
   *
   * An ANSWERED form summons nobody, so it releases the hold: the operator has already done the
   * one thing the hold demands. Without that, a form answered at 96 whose revise then crashed
   * would keep holding the blog while the app refused a second submit against an already answered
   * form, which is a blog with no exit.
   */
  answered: boolean;
  /**
   * WHO answered, when `answered` is true: "client" when any answer arrived through the client
   * portal, "operator" when the answers were filed here. The difference is an obligation: an
   * operator's submit already dispatched its revise, but the portal has no engine behind it, so
   * a client-answered form is a revise WAITING FOR THE OPERATOR'S RERUN, and the UI must say so
   * and offer the button. Null when unanswered.
   */
  answered_by: "client" | "operator" | null;
  /**
   * The answer texts, present exactly when `answered` is true. The operator reads what the
   * client actually wrote before spending a rerun on it; before answering there is nothing to
   * carry, and the field is null rather than [].
   */
  answers: { id: string; answer: string }[] | null;
};

/**
 * What POST /answers takes. Every question is answered or the engine refuses the whole body
 * with a 422 naming the ids, so this shape never carries a partial set.
 */
export type AnswersBody = {
  answers: { id: string; answer: string }[];
};

/**
 * What the engine reports after pushing one blog to the Strategi CMS.
 *
 * Exactly one of created / updated / skipped describes what happened. `skipped` is a
 * SUCCESS carrying the CMS's reason: a human already moved that post past draft, so our
 * content was correctly not applied and there is nothing to retry.
 */
export type PublishResult = {
  post_id: string | null;
  slug: string | null;
  /** Always "draft" on a fresh push. The CMS owns the lifecycle; the engine never sets it. */
  status: string | null;
  created: boolean;
  updated: boolean;
  skipped: string | null;
  preview_token: string | null;
};

/**
 * One selection comment on a shipped blog: someone selected rendered text, wrote an
 * instruction, and a short Claude session applies it to that passage.
 *
 * "applying" is the only spinning state, and "open" is the only one waiting on a person:
 * a client's suggestion is recorded from the portal with no Claude behind it, and it sits
 * open until the admin presses Resolve with Claude or dismisses it. An operator's own
 * comment is born applying, so open on an operator comment never occurs in practice. A
 * failed comment carries the engine's own reason in `error` and changed nothing; a
 * resolved one carries the exact old/new replacements the session made in `edits`; a
 * dismissed one was settled by hand and the UI hides it rather than deleting the record.
 */
export type BlogCommentState = "open" | "applying" | "resolved" | "failed" | "dismissed";

/**
 * One reply under a comment: a sentence somebody wrote in the thread, and nothing else.
 *
 * A reply carries no selection, no state and no apply verdict, because it ASKS FOR NOTHING.
 * The whole point of the door is that an operator can say "we cut that line, it was a
 * duplicate" without a Claude session deciding the request on the client's behalf and
 * without the comment vanishing from the client's rail as though it had been handled.
 *
 * The text travels as `body` rather than `instruction`, which is the name the record's own
 * column carries, so that no consumer can talk itself into feeding a reply to the apply
 * session. Replies are never top-level entries in a comments read, and they are counted by
 * nothing: a polite "thanks, looks good" must never hold a re-send.
 */
export type BlogCommentReply = {
  id: string;
  /** UTC ISO, from the engine. */
  created: string;
  author: "operator" | "client";
  /** Who wrote it, by email. "" when the engine could not say. */
  author_email: string;
  body: string;
};

export type BlogComment = {
  id: string;
  /** UTC ISO, from the engine. */
  created: string;
  /**
   * Which SIDE filed it, because the two sides owe it different acts: an operator comment
   * runs itself, a client comment waits for the admin to resolve or dismiss it.
   */
  author: "operator" | "client";
  /** Who filed it, by email. "" when the engine could not say. */
  author_email: string;
  /** The rendered text the author selected, verbatim. */
  selected_text: string;
  context_before: string;
  context_after: string;
  /** The author's instruction for the selected passage. */
  instruction: string;
  state: BlogCommentState;
  /** Null until the comment settles: resolved, failed, or dismissed. */
  finished: string | null;
  /** The engine's own sentence when state is "failed". Shown verbatim, never paraphrased. */
  error: string | null;
  /** The replacements actually made, present exactly when state is "resolved". */
  edits: { old: string; new: string }[] | null;
  /**
   * When this comment last ENTERED state "applying", UTC ISO, or null while it never has.
   *
   * THE CLOCK FOR "applying since", and `created` is the wrong one: a comment filed an hour
   * ago and retried a minute ago is one minute into its apply, so created there tells the
   * operator an apply has hung when nothing has. The engine ages its stranded-apply sweep on
   * this same field, for the same reason, so the two agree about what "since" means.
   */
  applying_since: string | null;
  /**
   * The thread under this comment, oldest first, and empty for most comments. ALWAYS
   * present, even empty: a surface that has to test for the key renders "undefined replies"
   * the first time one arrives. HISTORY ONLY: the reply feature is removed, so nothing ever
   * appends to this again; it renders rows filed before the removal.
   */
  replies: BlogCommentReply[];
  /**
   * UTC ISO when this comment was reframed and appended to the brand's custom instructions,
   * or null. The stamp is what keeps "Added to instructions" disabled across reloads and
   * across operators. Optional on the wire: an engine one pull behind serves comments
   * without the key.
   */
  added_to_instructions?: string | null;
};

export type BlogCommentsResponse = {
  comments: BlogComment[];
};

/** What POST /comments takes. Context is optional help for placing an ambiguous selection. */
export type AddCommentBody = {
  selected_text: string;
  instruction: string;
  context_before?: string;
  context_after?: string;
};

/** What POST /content answers: the committed word count, measured as the record measures it. */
export type SaveContentResult = {
  word_count: number;
};

/**
 * What the mechanical gates said about an uploaded article.
 *
 * ADVISORY, and the shape says so: `ran` is separate from `passed` because "we did not
 * check" and "we checked and it was clean" must never look the same to the operator. A
 * missing gates.json, a timeout, or a crashed run reports ran:false with a reason, and the
 * dialog says the gates could not run rather than implying the article is fine.
 *
 * The engine does NOT block an upload on a failure here. See the engine's blog_upload
 * module docstring: an uploaded article was written under a different process by someone
 * taking responsibility for it, and refusing it would leave them with a file they cannot
 * get into the app and no editor to fix it in.
 */
export type UploadGateReport = {
  ran: boolean;
  /** Only meaningful when ran is true. */
  passed?: boolean;
  /** Why the gates could not run. Empty when they did. */
  reason?: string;
  /** One line per failing rule, shaped "[FAIL] rule-name  detail". */
  failures: string[];
};

/** What POST /blogs/{topic}/upload answers once the article is committed and in review. */
export type UploadBlogResult = {
  topic_slug: string;
  word_count: number;
  /** The version this upload created. 1 on a first upload, higher on a replace. */
  version_no: number | null;
  /** Whether this overwrote an article that was already there. */
  replaced: boolean;
  gates: UploadGateReport;
  /** How many Word comments were imported as open change requests. Absent on a markdown upload. */
  comments_added?: number;
};

/**
 * Where one blog sits in the client review loop, exactly as the engine's sent_state reports
 * it. GET /review answers with this, and so does POST /send, because a send is a move in
 * this state machine and the caller should not need a second read to learn where it landed.
 *
 * The states are DERIVED, never stored: sent with open changes is "changes requested", sent
 * and approved is "approved", sent otherwise is "sent for client review", and unsent is the
 * editable admin-review stage. Every send re-stamps sent_to_client and CLEARS the approval,
 * because an approval describes one exact article and a re-send replaces it.
 */
export type BlogReviewState = {
  /** The latest send, UTC ISO, or null while the blog is still the team's. */
  sent_to_client: string | null;
  sent_to_client_by: string | null;
  /** When the client approved the SENT article, or null. Cleared by every send. */
  client_approved: string | null;
  client_approved_by: string | null;
  /**
   * The client's open and applying comments. Above zero, the engine refuses a re-send:
   * every suggestion is resolved or dismissed before the client sees a new version.
   */
  changes_requested: number;
  /**
   * Whether a change-request round is open: the client asked for something since the last send.
   * Drives the STATE, where changes_requested drives the outstanding COUNT. See BlogSummary's
   * copy of this field and lib/blog-state.ts for why the two are separate.
   */
  change_round_open: boolean;
  /**
   * When this article was last pushed to the CMS, or null. NULL MEANS "NO RECORD OF A PUSH",
   * never "not published": migration 012 added the column with no backfill, so nothing pushed
   * before it left a stamp behind. Render the positive fact and stay silent otherwise.
   */
  published: string | null;
  /**
   * The CMS's own word for this post, "draft" or "published", or null when nothing can tell.
   * The hosted build never reads this column (012 grants only published_at), so a null is
   * "unknown" rather than "draft" and never licenses saying the article is live.
   */
  cms_status: string | null;
};

/** The server whitelists exactly these artifact names, so the client should too. */
export const OUTPUT_FILES = [
  "blog.md",
  "eval.md",
  "dossier.md",
  "status.jsonl",
  "links-verified.txt",
] as const;

export type OutputFile = (typeof OUTPUT_FILES)[number];

// ---------------------------------------------------------------------------
// Monthly reports
// ---------------------------------------------------------------------------

/** One engine's AI-mention count for a month. `engine` is "ChatGPT" | "Gemini" | "Claude". */
export type ReportEngineMention = { engine: string; value: number };

/**
 * The dashboard-facing KPI block the geo-site-report skill emits. Every value is an ABSOLUTE
 * count for its month: deltas and the all-months trend are derived in the UI from the stored
 * history of earlier months, never sent here. `total` is derived from `by_engine`.
 */
export type ReportMetrics = {
  month_label?: string | null;
  ai_mentions: { total?: number; by_engine: ReportEngineMention[] };
  backlinks: number | null;
  referring_domains: number | null;
  note?: string | null;
};

/**
 * One Google Lighthouse category, as the geo-site-report skill pulls it from DataForSEO's
 * `on_page_lighthouse`. Both scores are real measurements: `desktop` is always run, `mobile`
 * only when a second call was made (null otherwise, which the UI shows as "n/a"). A score may
 * arrive as 61 or 0.61; the UI normalises both to 61.
 */
export type ReportLighthouseScore = {
  category: string;
  desktop: number | null;
  mobile?: number | null;
};

/** One Core-Web-Vitals-style row under the Lighthouse scores (value + target + severity). */
export type ReportLighthouseMetric = {
  metric: string;
  value: string;
  target?: string | null;
  status?: string | null;
};

/**
 * The Lighthouse block. Real Google Lighthouse numbers from DataForSEO, never inferred: when the
 * lookup does not return, the whole block is absent rather than filled with a guess.
 */
export type ReportLighthouse = {
  scores: ReportLighthouseScore[];
  metrics?: ReportLighthouseMetric[];
  form_factor_note?: string | null;
  seo_score_caveat?: string | null;
};

/**
 * One action in the plan of action. `fix` is the suggested solution, `why` its rationale/impact,
 * `effort` a free-text pill ("Quick win"), `severity` colours it. Ordered quick-wins-first by
 * the skill.
 */
export type ReportPriorityFix = {
  fix: string;
  why?: string | null;
  effort?: string | null;
  severity?: string | null;
};

/**
 * The full report.json a report session writes. The dashboard reads `metrics`, `lighthouse` and
 * `priority_fixes` (the plan of action); the remaining audit prose (modules, AI standing, verify
 * list) rides in the PDF, so the rest is left loose rather than typed field by field.
 */
export type ReportDocument = {
  metrics: ReportMetrics;
  lighthouse?: ReportLighthouse | null;
  priority_fixes?: ReportPriorityFix[];
  site_name?: string;
  url?: string;
  audit_date?: string;
  snapshot?: { verdict?: string | null; lines?: string[] };
  [key: string]: unknown;
};

/**
 * The four states a month sits in, all derived server-side from one row's timestamps:
 * - `none`               nothing generated for this month.
 * - `generated_unshared` a working report the client has not been sent (also the state after a
 *                        regenerate, when generated_at is newer than the last share).
 * - `generated_shared`   a working report the client is seeing the same version of.
 * - `deleted_shared`     the working report was deleted, but the client still sees the snapshot
 *                        that was shared before the delete.
 */
export type ReportStatus = "none" | "generated_unshared" | "generated_shared" | "deleted_shared";

/**
 * One month, as the admin dashboard sees it. `report` is the WORKING copy the operator owns:
 * null for a deleted month (the deleted report is deliberately unseeable to the operator) and
 * null for a month never generated. The client's shared snapshot is never returned here.
 */
export type MonthReport = {
  month: string; // YYYY-MM
  status: ReportStatus;
  report: ReportDocument | null;
  has_pdf: boolean;
  generated_at: string | null;
  generated_by: string | null;
  shared_at: string | null;
  shared_by: string | null;
};

export type ReportsResponse = {
  /** The engine's current calendar month: the one Generate targets. */
  current_month: string;
  /** Every month this brand holds plus the current month, newest first. */
  reports: MonthReport[];
};

/** Same three-state shape as every other engine job: "running" is the only one with a clock. */
export type ReportGenJobState = "running" | "done" | "failed";

/** One report generation, as the engine remembers it. Survives a refresh, read from GET. */
export type ReportGenJob = {
  client: string;
  month: string;
  state: ReportGenJobState;
  started: string;
  finished: string | null;
  /** The agent's final message: the numbers it pulled and whether the PDF rendered. */
  summary: string | null;
  error: string | null;
  /** Whether a PDF landed with the report. Absent while running. */
  has_pdf?: boolean;
};

export type ShareReportResult = {
  month: string;
  status: "generated_shared";
  shared_at: string;
  shared_by: string;
};

// ---------------------------------------------------------------------------
// Monthly ANALYSIS (the deep six-tool GEO + SEO report). Kept separate from Reports on purpose.
// The dashboard and the branded PDF render the SAME normalized analysis.json, so on-screen numbers
// and the download can never disagree. Every value is an ABSOLUTE count for its month; the UI
// derives month-over-month from stored history (or from a card's own prev_value). Sections whose
// tool is not connected are simply absent (graceful degradation). Schema of record:
// .claude/skills/geo-analysis-report/references/analysis-schema.md.
// ---------------------------------------------------------------------------

/** One card in Section 0's snapshot scorecard. `available: false` renders greyed as "Not connected". */
export type AnalysisScorecardCard = {
  key: string;
  label: string;
  value: string | number;
  prev_value?: string | number | null;
  unit?: string | null;
  spark?: number[] | null;
  tool: string;
  available: boolean;
  note?: string | null;
};

/** One (prompt, engine) cell in the prompt visibility matrix. A null state renders neutral. */
export type AnalysisMatrixCell = {
  engine: string;
  state: "cited" | "mentioned" | "absent" | null;
  change?: "new" | "lost" | null;
};

export type AnalysisPromptRow = { prompt: string; cells: AnalysisMatrixCell[] };

export type AnalysisPromptMatrix = {
  coverage_pct?: number;
  engines: string[];
  prompts: AnalysisPromptRow[];
};

/** One Lighthouse category, same normalisation rules as the Reports tab (61 or 0.61 both read 61). */
export type AnalysisLighthouseScore = { category: string; desktop: number | null; mobile?: number | null };

/** The full analysis.json. Only the floor is required; every other section is optional and absent
 *  when its tool is not connected. The rest is left loose rather than typed field by field. */
export type AnalysisDocument = {
  client: { name: string; slug?: string; domain?: string; industry?: string };
  month: string;
  month_label: string;
  brand?: { org_name?: string; accent?: string } | null;
  scorecard: AnalysisScorecardCard[];
  executive_summary?: { paragraphs?: string[]; did?: string[]; next?: string[] } | null;
  ai_visibility: {
    prompt_matrix: AnalysisPromptMatrix;
    citations?: { prompt: string; engine: string; snippet: string }[];
    gaps?: { prompt: string; play: string }[];
    referral_traffic?: {
      by_source?: { source: string; sessions: number; engaged: number; conversions: number }[];
    } | null;
    bing_indicator?: { impressions: number; clicks: number; indexed: number; key_pages: number } | null;
    ai_overview?: { keyword: string; aio_present: boolean; client_cited: boolean }[];
  };
  seo_visibility?: {
    google?: { clicks: number; impressions: number; avg_position: number; ctr: number;
               prev_clicks?: number; prev_impressions?: number; prev_avg_position?: number; prev_ctr?: number } | null;
    striking_distance?: { query: string; position: number; impressions: number; url: string }[];
    rankings?: { keyword: string; position: number; delta?: number; volume?: number; url?: string }[];
    serp_features?: { feature: string; owned_this: number; owned_last: number }[];
    bing?: { clicks: number; impressions: number; avg_position: number } | null;
    index_health?: { google?: { indexed: number; errors: number; dropped: number };
                     bing?: { indexed: number; errors: number; dropped: number } } | null;
    tech_health?: { lighthouse?: { scores: AnalysisLighthouseScore[] };
                    schema_coverage_pct?: number | null; cwv_status?: string | null } | null;
  } | null;
  engagement?: {
    landing_pages?: { page: string; scroll_pct: number; avg_time: string; top_click: string }[];
    friction?: { page: string; type: string; count: number; delta?: number }[];
  } | null;
  outcomes?: {
    organic_sessions: number; prev_organic_sessions?: number; engaged_sessions?: number;
    conversions_organic: number; conversions_ai?: number; summary?: string;
  } | null;
  plan?: { did?: string[]; next?: { item: string; source?: string }[] } | null;
  appendix?: { notes?: string[] } | null;
  tools: { name: string; connected: boolean; note?: string }[];
  [key: string]: unknown;
};

export type AnalysisStatus = "none" | "generated";

/** One month, as the admin Analysis tab sees it. `analysis` is null for a month never run. */
export type AnalysisMonth = {
  month: string; // YYYY-MM
  status: AnalysisStatus;
  analysis: AnalysisDocument | null;
  has_pdf: boolean;
  generated_at: string | null;
  generated_by: string | null;
};

export type AnalysisResponse = {
  current_month: string;
  analyses: AnalysisMonth[];
};

/** One analysis run, as the engine remembers it. Same three-state shape as every other engine job. */
export type AnalysisGenJob = {
  client: string;
  month: string;
  state: "running" | "done" | "failed";
  started: string;
  finished: string | null;
  summary: string | null;
  error: string | null;
  has_pdf?: boolean;
};

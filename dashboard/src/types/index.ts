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
  demo_mode: boolean;
  /**
   * Present on GET /api/clients, and NOT sent by GET /api/orgs, which returns brands
   * undecorated. lib/orgs-context fills it in from the client list before any brand reaches a
   * component, so every brand read through useOrgs carries it. Do not fetch a brand from
   * /api/orgs directly and trust this field.
   */
  preflight: Preflight;
  description: string;
  domain: string;
  industry: string;
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
  geo_mock: boolean;
  orgs: Org[];
};

/**
 * geo_mock is a global switch, not a per client flag: when it is on, real clients produce
 * fake output too. It rides on the client list so every page can see it.
 */
export type ClientsResponse = {
  geo_mock: boolean;
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

export type CreateClientBody = {
  name: string;
  domain: string;
  industry: string;
  description?: string;
  demo_mode?: boolean;
  /**
   * The org to file this brand under, by NAME rather than slug: the operator can type a new
   * org here, and the engine slugifies and matches. Omitted means the brand is its own
   * single-brand org.
   */
  organisation_name?: string;
};

export type UpdateClientBody = Partial<CreateClientBody>;

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
  /** True when nothing real was called, so nothing was spent. */
  mock: boolean;
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
  /** True when nothing real was called, so nothing was spent. */
  mock: boolean;
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
};

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
  topics: RunTopic[];
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
  status: BlogStatus;
  /** Null on the same path that produces status "unknown": no status line, no count. */
  iterations: number | null;
  shipped: boolean;
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

/** The server whitelists exactly these artifact names, so the client should too. */
export const OUTPUT_FILES = [
  "blog.md",
  "eval.md",
  "dossier.md",
  "status.jsonl",
  "links-verified.txt",
] as const;

export type OutputFile = (typeof OUTPUT_FILES)[number];

-- GEO Factory: content schema for Supabase (Postgres 15/16/17).
--
-- Scope: the DATA that exists on disk today, and nothing else. There is no jobs
-- queue and no `runs` table here, deliberately: RUNS is an in-process dict in
-- server/runner.py holding asyncio handles, so no historical run record exists
-- anywhere to migrate. The worker queue belongs in the migration that
-- introduces the worker, not in the one that moves the corpus.
--
-- Every count in these comments was measured against the live corpus with the
-- app's OWN parsers, never with `wc -l`. Comments anchor to SYMBOL NAMES, never
-- line numbers: server/runner.py is edited concurrently and its lines move.
--
-- Idempotent: safe to re-run. Drops and rebuilds the public content schema.

begin;

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Teardown (this migration owns every object it drops)
-- ---------------------------------------------------------------------------
drop view  if exists v_review_notes    cascade;
drop view  if exists topic_rollup      cascade;
drop view  if exists topics_live       cascade;
drop view  if exists org_membership    cascade;

drop table if exists blog_comments     cascade;
drop table if exists review_notes      cascade;
drop table if exists ledger_entries    cascade;
drop table if exists status_events     cascade;
drop table if exists blog_versions     cascade;
drop table if exists topics            cascade;
drop table if exists roadmap_rows      cascade;
drop table if exists roadmap_sheets    cascade;
drop table if exists roadmap_uploads   cascade;
drop table if exists client_resources  cascade;
drop table if exists org_members       cascade;
drop table if exists app_admins        cascade;
drop table if exists client_members    cascade;
drop table if exists clients           cascade;
drop table if exists orgs              cascade;

drop function if exists auth_can_read_client(uuid) cascade;
drop function if exists auth_org_slugs()           cascade;
drop function if exists auth_is_admin()            cascade;
drop function if exists portal_suggest_change(text, text, text, text, text, text) cascade;
drop function if exists portal_reply_comment(text, text, uuid, text) cascade;
-- BOTH approve signatures. An earlier build of this file created the two-argument form,
-- and `create or replace` cannot change a signature: it adds an overload. Dropping only
-- the current one would leave a second, version-blind approve door callable forever, which
-- is exactly the stale-approval race the p_version argument exists to close.
drop function if exists portal_approve_blog(text, text, uuid) cascade;
drop function if exists portal_approve_blog(text, text) cascade;

drop type   if exists topic_status cascade;
drop type   if exists run_stage    cascade;
drop type   if exists stage_event  cascade;
drop type   if exists note_author  cascade;
drop domain if exists client_slug  cascade;
drop domain if exists topic_slug   cascade;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- Mirrors STATUSES / STAGES / EVENTS in .claude/status.py exactly.
-- 'stopped' is declared there and appears in ZERO of the 1,339 live lines.
-- It stays: the enum is sourced from the code, never from the data.
create type topic_status as enum ('running','done','needs_review','failed','stopped');
create type run_stage    as enum ('research','write','gates','links','eval','revise');
create type stage_event  as enum ('start','end');
create type note_author  as enum ('evaluator','operator','client');

-- '_fixture-unreviewed' is a real client slug, hence the optional underscore.
create domain client_slug as text check (value ~ '^_?[a-z0-9]+(-[a-z0-9]+)*$');
create domain topic_slug  as text check (value ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- ---------------------------------------------------------------------------
-- orgs / clients
-- ---------------------------------------------------------------------------

-- EXPLICIT organisations only. Measured: exactly ONE row (acme-group, holding
-- acme-north and acme-south). The other four clients carry no `organisation`
-- key in gates.json and MUST NOT get a row here.
--
-- server/clients.py `_organisation()` synthesizes a self-org on read, and the
-- code states why it is never written down: a self-referencing org is
-- deliberately not stored, because storing it twice invites the two copies to
-- disagree after a rename. Materialising self-orgs here reintroduces exactly
-- that drift. They are DERIVED by org_membership below, which reproduces the
-- four orgs /api/orgs actually returns.
create table orgs (
  id         uuid primary key default gen_random_uuid(),
  slug       client_slug not null unique,
  name       text        not null check (btrim(name) <> ''),
  created_at timestamptz not null default now()
);

create table clients (
  id          uuid primary key default gen_random_uuid(),
  -- NULLABLE on purpose: 4 of 6 clients have no explicit org. See orgs above.
  org_id      uuid references orgs(id) on delete restrict,
  slug        client_slug not null unique,   -- immutable: PATCH /api/clients/{slug} cannot change it
  name        text not null check (btrim(name) <> ''),
  domain      text not null default '',
  industry    text not null default '',
  description text not null default '',

  -- The client doc set, inlined. An existing-but-empty doc must round-trip as ''
  -- and an absent one as NULL: collapsing the two loses which files exist, and
  -- canonical_facts being NULL rather than '' is what has_canonical_facts turns on.
  client_md       text,
  canonical_facts text,
  -- Stamped by sync.commit_client_facts when a facts build lands. Nullable
  -- exactly when canonical_facts is: an absent record has no build time.
  canonical_facts_at timestamptz,

  demo_mode   boolean not null default false,
  -- gates.json MINUS "organisation" (modelled by org_id above).
  gates       jsonb not null default '{}'::jsonb,

  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  -- _preflight in server/app.py refuses to run a client whose canonical-facts.md
  -- still contains PLACEHOLDER. Measured: _fixture-unreviewed is the one that
  -- refuses; acme-north/acme-south have no facts file at all and pass, because
  -- their fact base is built at run time.
  preflight_ok boolean generated always as
                 (canonical_facts is null or strpos(canonical_facts, 'PLACEHOLDER') = 0) stored,
  is_fixture   boolean generated always as (left(slug, 1) = '_') stored,

  -- Composite-FK target: lets a child carry client_id and be structurally
  -- unable to point at a topic belonging to a different client.
  unique (id, org_id)
);

create index clients_org on clients (org_id);

-- The portal seam. Created EMPTY now so the schema is not rewritten when the
-- client portal lands. Without it there is no mapping from auth.users to a
-- client, and no RLS policy can be written against client_id at all.
create table client_members (
  client_id  uuid not null references clients(id) on delete cascade,
  user_id    uuid not null,                 -- auth.users(id)
  role       text not null check (role in ('admin','viewer','commenter')),
  created_at timestamptz not null default now(),
  primary key (client_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Identity: app_admins (Strategi staff) and org_members (client portal)
-- ---------------------------------------------------------------------------
-- These back the login. A row in app_admins IS the admin grant (sees all orgs
-- and brands). org_members scopes a client login at the ORG, keyed on the
-- DERIVED org slug (coalesce(orgs.slug, clients.slug)) that org_membership
-- exposes, NOT on orgs.id: only explicit multi-brand orgs have an orgs row, so a
-- uuid FK would cover acme-group alone and strand every single-brand client.
-- Both slugs are immutable, so the key never rewrites; a brand moving between
-- orgs re-derives its org_slug through the view at read time, so access follows
-- the move for free. user_id is a bare uuid (auth.users(id)) with no FK, exactly
-- like client_members: this schema must not couple to Supabase's auth schema.
create table app_admins (
  user_id    uuid primary key,              -- auth.users(id)
  email      text not null,                 -- denormalised for display; auth.users is not ours to join
  added_by   uuid,                          -- auth.users(id) who granted it; null for the seed admin
  created_at timestamptz not null default now()
);

create table org_members (
  org_slug   client_slug not null,          -- coalesce(orgs.slug, clients.slug); see org_membership
  user_id    uuid not null,                 -- auth.users(id)
  role       text not null check (role in ('admin','viewer','commenter')),
  created_at timestamptz not null default now(),
  primary key (org_slug, user_id)
);
create index org_members_user on org_members (user_id);

-- ---------------------------------------------------------------------------
-- Resources and uploads
-- ---------------------------------------------------------------------------

-- clients/<slug>/Resources/ (the capital R is deliberate per server/clients.py:
-- a lowercase variant would create a folder uploads land in and no agent reads).
-- Measured: 5 files, ~12.8 MB (vacation-village 4, blr-brewing 1).
-- Bytes live in Storage; this table is the index. Filenames CONTAIN SPACES, and
-- canonical-facts.md refers to the brochure by exact filename, so the original
-- name is preserved verbatim in `name` and never sanitized into the key.
create table client_resources (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  name         text not null check (btrim(name) <> '' and length(name) <= 255),
  object_path  text not null unique,          -- resources/<client_slug>/<sha256>
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   bigint not null check (size_bytes >= 0 and size_bytes <= 26214400),  -- MAX_RESOURCE_BYTES
  content_type text,
  uploaded_at  timestamptz not null default now(),
  unique (client_id, name)
);

-- clients/<slug>/uploads/ : the archived roadmap CSVs.
-- Measured: 39 files, all .csv, ~157 KB total. This is a SECURITY CONTROL, not
-- an archive: POST /generate re-parses the archived upload so a tampered browser
-- payload cannot redirect a run. It must fail CLOSED, so the bytes stay in
-- Postgres rather than Storage: a Storage round trip is one more thing that can
-- fail open at exactly the wrong moment.
create table roadmap_uploads (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  filename    text  not null,
  raw         bytea not null check (length(raw) > 0 and length(raw) <= 2097152),  -- MAX_UPLOAD_BYTES = 2*1024*1024
  uploaded_at timestamptz not null default now(),
  unique (client_id, filename)
);

create index roadmap_uploads_client on roadmap_uploads (client_id);

-- ---------------------------------------------------------------------------
-- Roadmap
-- ---------------------------------------------------------------------------

-- One sheet per client. Measured: 5 sheets (acme-north has NO roadmap.csv).
-- The UNIQUE on client_id IS the 409 the app returns on a second upload.
--
-- `raw_csv` holds the file byte-for-byte, and that is what makes the
-- raw-vs-built distinction lossless. read_sheet() returns 50 RAW rows across the
-- 5 sheets (including acme-south's blank row); load_roadmap()/_build_rows
-- returns 49 INGESTABLE rows. Both numbers are correct and describe different
-- things. roadmap_rows stores the 49; the 50-row preview regenerates from
-- raw_csv on demand. Neither is lost and the two cannot drift.
create table roadmap_sheets (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null unique references clients(id) on delete cascade,
  filename   text not null,
  raw_csv    text not null,
  columns    text[] not null,
  -- roadmap-report.md for generated sheets; null for uploads.
  report     text,
  modified   timestamptz,
  created_at timestamptz not null default now()
);

create table roadmap_rows (
  id        uuid primary key default gen_random_uuid(),
  sheet_id  uuid not null references roadmap_sheets(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,

  -- 0-based, and GAPS ARE LEGAL: _build_rows enumerates BEFORE skipping blank
  -- rows, so acme-south yields 0,1,3,4,5 with a real gap at 2. The skip rule is
  -- "every cell blank", not "topic blank": a row with an empty topic but a real
  -- `covers` is KEPT and surfaced to the operator. Never assert contiguity.
  row_index int not null check (row_index >= 0),

  topic     text not null,     -- COL_TOPIC   = 0
  covers    text not null,     -- COL_COVERS  = 1
  prompts   text[] not null,   -- COL_PROMPTS = 4
  extras    jsonb not null default '[]'::jsonb,   -- surplus columns, keyed by header

  -- Computed in Python with the app's own roadmap.slugify(), never re-derived in
  -- SQL: a second implementation of a slug rule is a second thing to drift.
  -- NULLABLE because an incomplete row may have no topic to slugify.
  topic_slug topic_slug,

  -- cardinality(), NOT array_length(): array_length('{}',1) returns NULL, which
  -- would make `complete` NULL rather than false for the exact row this column
  -- exists to catch (topic and covers present, prompts empty). `WHERE NOT
  -- complete` then silently drops it, and prompts are BINDING per CLAUDE.md.
  complete boolean generated always as
             (btrim(topic) <> '' and btrim(covers) <> '' and cardinality(prompts) > 0) stored,

  -- The app returns `missing` to the operator verbatim in its 422. `complete`
  -- alone cannot rebuild which field was absent.
  missing text[] generated always as (
            array_remove(array[
              case when btrim(topic)  = ''       then 'topic'   end,
              case when btrim(covers) = ''       then 'covers'  end,
              case when cardinality(prompts) = 0 then 'prompts' end], null)) stored,

  unique (sheet_id, row_index)
);

create index roadmap_rows_client on roadmap_rows (client_id);

-- NOT UNIQUE, and the live corpus is why. A UNIQUE (client_id, topic_slug) here
-- looks obviously right and is wrong: clients/demo/roadmap.csv holds two rows
-- that are both topic='x', covers='y', prompts=['z'], and the real migration
-- refused them with a 23505.
--
-- The engine does not hold this invariant. roadmap.index_by_slug builds
-- {row["topic_slug"]: row["index"]} as a plain dict comprehension, so duplicate
-- slugs silently collapse and the LAST row wins. That is a quirk worth knowing
-- (the earlier row becomes unreachable from a blog's back-reference), but it is
-- the engine's quirk to change, not this migration's to enforce. A schema
-- stricter than its app rejects the operator's actual file.
--
-- topics (client_id, slug) IS unique, and that is a different claim: one OUTPUT
-- folder per slug. Two roadmap rows may race for one output; only one exists.
create index roadmap_rows_slug on roadmap_rows (client_id, topic_slug);

-- ---------------------------------------------------------------------------
-- topics / blog_versions
-- ---------------------------------------------------------------------------

-- One row per output folder. Measured: 50 (demo 30, blr-brewing 10,
-- vacation-village 6, acme-north 4; acme-south and _fixture-unreviewed have 0).
--
-- THE CASE HAZARD: the folder is outputs/BLR-Brewing while the client is
-- clients/blr-brewing. Those genuinely differ; the app resolves them only
-- because APFS case-folds. `client_id` here always points at the canonical
-- lowercase client. The migration casefold-matches and asserts a single hit.
--
-- status / score / iterations are NOT stored. They are a fold over
-- status_events, derived by topic_rollup below. A stored rollup drifts the
-- moment an event is appended without the matching UPDATE; at 1,339 events the
-- view costs nothing and cannot drift by construction.
create table topics (
  id        uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  slug      topic_slug not null,
  title     text,

  dossier    text,
  dossier_at timestamptz,

  -- links-verified.txt, verbatim and OPAQUE. Measured across the 16 files: 951
  -- comment lines, 201 URL lines, 17 non-URL fragments, 130 blanks. It is a
  -- working log that happens to contain URLs, not a link table. Parsing it into
  -- rows would invent structure the file does not have.
  links_verified text,

  -- The NEEDS_REVIEW marker's contents. Measured: 13 markers, and ONE
  -- (blr-brewing/how-to-plan-a-corporate-team-outing) is ZERO BYTES. Present but
  -- empty must be '' and absent must be NULL, or the marker's existence is lost.
  -- The marker is deliberately not served by the artifact endpoint.
  review_note text,

  shipped_version_id uuid,

  -- The admin-review exit stamp (004, re-stampable since 005): a shipped blog is
  -- client-visible on the portal only once an operator pressed Send to client. Null means
  -- the blog, shipped or not, is still the team's. Engine-side, and EVERY send re-stamps
  -- it: after a review round, Send again is a new release of changed bytes, not a repeat
  -- of the first one, so the date moves and the approval below is cleared with it.
  sent_to_client_at timestamptz,
  sent_to_client_by text,

  -- WHICH version the send released (005): the portal renders this version and a client
  -- suggestion anchors to it, so an admin edit committed after the send cannot silently
  -- move the text the client is commenting on. FK added after blog_versions, exactly
  -- like shipped_version_id.
  sent_version_id uuid,

  -- The client's approval (005). mark_sent clears both on every send: an approval
  -- describes the exact release the client read, and it must not survive a re-send of
  -- different bytes as though the client had approved those too. client_approved_by is
  -- an email and stays off the authenticated grants, like sent_to_client_by.
  client_approved_at timestamptz,
  client_approved_by text,

  created_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint dossier_ts check ((dossier is null) = (dossier_at is null)),
  unique (client_id, slug),
  -- Composite-FK target. A blog_versions row whose client_id disagrees with its
  -- topic's client_id is then rejected by the database, not by a code path
  -- someone has to remember to write.
  unique (id, client_id)
);

create index topics_client_live on topics (client_id) where deleted_at is null;

-- Versioned blog bodies. TEXT, not Storage: the whole corpus is 1.4 MB (blogs
-- 345 KB, largest single blog 18 KB), and the artifact endpoint already answers
-- text/plain. Storage would add a network hop and a second consistency domain to
-- move less data than a single Resources PDF.
--
-- The migration writes exactly ONE version per topic (version_no = 1). Versions
-- exist for the review portal: a client comment must anchor to the exact bytes
-- it was written against, and an edit that reflows the text must not silently
-- relocate the comment.
--
-- COMMIT RULE, and it is not the obvious one: commit a new version only when a
-- session produced a SCORED draft. The engine restores the previous bytes when a
-- revise earns no score, so "commit after the terminal line" would re-commit the
-- original as a duplicate. And there is deliberately NO score comparison: the
-- clarified draft ships at 91 as readily as at 97, because a comparison guarding
-- a correctness pass hands back the original with its violation still in it.
-- `superseded_reason` records "the revise produced no score, so the original was
-- restored", never "scored lower, so it lost".
create table blog_versions (
  id         uuid primary key default gen_random_uuid(),
  topic_id   uuid not null,
  client_id  uuid not null,
  version_no int not null check (version_no >= 1),
  iteration  int check (iteration between 1 and 8),   -- observed 1..4

  body       text not null check (length(body) > 0),
  h1_title   text,
  word_count int check (word_count >= 0),

  score      int check (score between 0 and 100),
  eval_body  text,

  shipped    boolean not null default false,
  superseded_reason text,

  -- Backfilled from blog.md's mtime, NOT now(): the app's own history falls back
  -- to mtime for a blog's date, and stamping now() would re-sort every migrated
  -- blog to today.
  committed_at timestamptz not null default now(),

  foreign key (topic_id, client_id) references topics(id, client_id) on delete cascade,
  unique (topic_id, version_no),
  unique (id, topic_id)
);

create index blog_versions_topic on blog_versions (topic_id, version_no desc);

alter table topics add constraint topics_shipped_version_fk
  foreign key (shipped_version_id, id) references blog_versions(id, topic_id)
  on delete set null;

alter table topics add constraint topics_sent_version_fk
  foreign key (sent_version_id, id) references blog_versions(id, topic_id)
  on delete set null;

-- ---------------------------------------------------------------------------
-- status_events
-- ---------------------------------------------------------------------------

-- APPEND-ONLY. Measured: 1,339 lines, 0 malformed, 0 blank, 0 duplicate ts.
--
-- `line_no` is the 0-based ordinal within the topic's status.jsonl, and it is
-- the real key. The file is append-only, so line N is permanently the same
-- event: it makes reload idempotent, and it preserves the ordinal ordering the
-- terminal-line scan depends on. `ts` matches that order only incidentally and
-- carries no uniqueness guarantee.
--
-- There is deliberately NO run_id column. .claude/status.py has no --run-id
-- argument and ZERO of the 1,339 live lines carry one; the agent does not know
-- its run_id. A column that is NULL for every row is a promise the writer cannot
-- keep. Add it when status.py can populate it.
--
-- There is also deliberately NO "one terminal line per topic per run" uniqueness
-- constraint. The engine APPENDS a second terminal line inside one run when it
-- disagrees with the lead's verdict, on purpose, so the disagreement stays
-- visible on disk. Measured: 4 such correction pairs, all blr-brewing. A
-- uniqueness index here rejects that write.
create table status_events (
  id        bigserial primary key,
  topic_id  uuid not null,
  client_id uuid not null,
  line_no   int  not null check (line_no >= 0),

  ts     timestamptz not null,        -- status.py's own UTC stamp
  stage  run_stage   not null,
  event  stage_event not null,
  iter   int not null check (iter >= 1),          -- live range 1..4
  score  int check (score between 0 and 100),
  status topic_status not null default 'running',
  note   text not null default '',

  -- 12 lines across 4 topics report a CLIENT slug in their `slug` field instead
  -- of the topic slug. The directory is the truth; this preserves what the line
  -- actually said rather than quietly correcting the record.
  slug_reported text,

  foreign key (topic_id, client_id) references topics(id, client_id) on delete cascade,
  unique (topic_id, line_no),

  -- Measured: score is non-null on exactly 198 lines, ALL of them (eval,end).
  -- Not luck: the engine deliberately tags its cancel and crash lines stage=eval
  -- so the summary can read a score off them.
  constraint score_only_on_eval_end check (score is null or (stage = 'eval' and event = 'end'))
);

create index status_events_topic_line on status_events (topic_id, line_no);
create index status_events_eval_score on status_events (topic_id, line_no desc)
  where stage = 'eval' and event = 'end' and score is not null;

-- ---------------------------------------------------------------------------
-- ledger_entries
-- ---------------------------------------------------------------------------

-- The ship record: clients/<slug>/generated.csv, one row per shipped topic.
-- Measured with csv.DictReader: 72 rows, 0 duplicates. (The "147" that has been
-- quoted around this project is 153 physical lines minus 6 headers: 69 of the 72
-- rows carry embedded newlines inside quoted `prompts` cells. CLAUDE.md warns
-- about exactly this.)
--
-- THE UNIQUE IS THE FIX. server/ledger.py checks membership OUTSIDE the lock it
-- takes to append, so two concurrent ships of one slug both see "absent" and
-- both append. It duplicates; it cannot lose a write. Zero violations exist
-- today, which is precisely why the constraint is free to add now. record_success
-- becomes ON CONFLICT DO NOTHING and the racy pre-check is DELETED, not fixed.
--
-- NO topic_id FK, and that is load-bearing: this is a historical SNAPSHOT that
-- must outlive what it references. Measured: 34 of 72 rows are orphans with no
-- blog on disk (acme-south is 100% orphaned, 10 rows and 0 blogs). An FK would
-- reject them.
create table ledger_entries (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  topic_slug   topic_slug not null,
  topic        text not null default '',
  covers       text not null default '',
  prompts      text[] not null default '{}',

  -- Typed int at ingest via NULLIF(raw,'')::int, never cast at query time.
  -- record_success writes "" when score is None. All 72 rows are numeric 95-98
  -- TODAY, which is why a query-time cast has not thrown yet: latent, not safe.
  score        int check (score between 0 and 100),
  generated_at timestamptz not null default now(),

  -- TEXT, not uuid, and no FK. Measured: 68 rows carry a 32-char hex run_id and
  -- 4 carry the literal string 'retro-fix', which cannot cast to uuid. RUNS is
  -- an in-process dict, so no run record exists for any of them anyway.
  run_id       text,

  unique (client_id, topic_slug)
);

create index ledger_entries_client on ledger_entries (client_id);

-- ---------------------------------------------------------------------------
-- review_notes
-- ---------------------------------------------------------------------------

-- One table for evaluator questions, operator answers, and (later) client
-- comments. Measured: 9 questions.json holding 16 question items, and ZERO
-- answers.json, so the reply path migrates nothing and is unexercised.
--
-- Anchored to blog_version_id, not to an iteration number: an iteration is not
-- unique per topic, and the anchor is what makes staleness an FK comparison
-- rather than an integer that resembles one.
create table review_notes (
  id              uuid primary key default gen_random_uuid(),
  topic_id        uuid not null,
  client_id       uuid not null,
  blog_version_id uuid not null,
  parent_id       uuid references review_notes(id) on delete cascade,

  author    note_author not null,
  author_id uuid,                    -- auth.users(id), null for engine-authored
  ref       text,                    -- 'q1', 'q2', ... within a round
  area      text check (area is null or area in ('Sourcing','Structure','Draft','Mechanics')),
  body      text not null check (btrim(body) <> ''),
  why       text,

  -- questions.json carries its own score: the score AT ASKING TIME, which is a
  -- record of what was true when the question was asked and legitimately differs
  -- from the topic's score now. Measured: blr-brewing/the-best-beer-gardens asked
  -- at iter 1 / score 89 and finished iter 2 / score 95.
  asked_score int check (asked_score between 0 and 100),
  -- The form's iteration at asking time, from questions.json. Staleness
  -- compares it against the topic's current iteration.
  asked_iter  int check (asked_iter is null or asked_iter >= 1),

  -- W3C text-quote selector: {quote, prefix, suffix}. Null for whole-draft notes.
  anchor     jsonb,
  created_at timestamptz not null default now(),

  foreign key (topic_id, client_id)       references topics(id, client_id)        on delete cascade,
  foreign key (blog_version_id, topic_id) references blog_versions(id, topic_id)  on delete cascade,
  constraint evaluator_states_why check (author <> 'evaluator' or (why is not null and area is not null)),
  constraint reply_has_no_area    check (parent_id is null or area is null),
  unique (blog_version_id, ref)
);

create index review_notes_topic on review_notes (topic_id, created_at);

-- ---------------------------------------------------------------------------
-- blog_comments (005): selection comments, one table for both surfaces
-- ---------------------------------------------------------------------------

-- One row per selection comment, operator-authored and client-authored both, PLUS the
-- replies that hang off one. This is the record, not a working file: the client files
-- suggestions from the hosted portal with no engine behind it, and two engines share one
-- record, so a comment teammate A resolves must read as resolved on teammate B's machine.
-- The state machine: 'open' (filed, nothing running; every client suggestion starts here),
-- 'applying' (a Claude apply session is live on some engine), 'resolved' (the edit landed
-- and committed), 'failed' (the apply refused or died; error says why, and Resolve retries
-- it), 'dismissed' (closed without an edit). Operator comments skip 'open': the engine
-- auto-applies them at filing.
create table blog_comments (
  id              uuid primary key default gen_random_uuid(),
  topic_id        uuid not null,
  client_id       uuid not null,
  -- The version the selection was made against: topics.sent_version_id at filing time
  -- for client suggestions, null for engine-filed operator comments (their apply always
  -- runs against the record's latest body). Informational anchor with deliberately NO
  -- FK: a comment must outlive the version it quotes, the way ledger_entries outlive
  -- the topics they record, or pruning history silently deletes a client's request.
  blog_version_id uuid,
  -- The thread pointer (005): null on a top-level comment, the parent's id on a REPLY. A
  -- reply carries its text in `instruction`, leaves selected_text and both context columns
  -- empty, and is never applied, never counted, never resolved: it is someone TALKING
  -- ABOUT the change, not a second change request. Every count and every apply path
  -- therefore filters `parent_id is null`, and getting that wrong makes a client's
  -- "thanks, looks good" reply read as an open suggestion that blocks Send again forever.
  parent_id       uuid references blog_comments(id) on delete cascade,
  author          text not null check (author in ('operator','client')),
  author_email    text not null default '',
  selected_text   text not null,
  context_before  text not null default '',
  context_after   text not null default '',
  instruction     text not null,
  state           text not null default 'open'
                    check (state in ('open','applying','resolved','failed','dismissed')),
  error           text,
  edits           jsonb,
  created_at      timestamptz not null default now(),
  -- When this row last entered state 'applying', stamped on EVERY transition into it (the
  -- insert of an operator comment, and every Resolve). created_at is the WRONG clock for
  -- the stranded-apply sweep and this column exists to say so: a comment filed an hour ago
  -- and retried a minute ago is a LIVE apply, and an age guard reading created_at fails it
  -- the moment any engine boots, killing a session that is still working.
  applying_since  timestamptz,
  finished_at     timestamptz,
  foreign key (topic_id, client_id) references topics(id, client_id) on delete cascade,
  -- ONE level of nesting, exactly like a document comment thread: a reply is 'open' and
  -- stays there, so nothing can resolve, apply, or dismiss it. This constraint cannot see
  -- the parent's own parent_id, so portal_reply_comment refuses a parent that is itself a
  -- reply; the two rules together are what keep a thread flat, and neither is redundant
  -- (a function check cannot stop a later UPDATE, and a row check cannot read the parent).
  constraint blog_comments_reply_open check (parent_id is null or state = 'open')
);

create index blog_comments_topic on blog_comments (topic_id, created_at);
-- Replies are read BY PARENT, one query for a whole page of threads. Without this index
-- that read is a sequential scan of the table on every stage-page poll, ten seconds apart.
create index blog_comments_parent on blog_comments (parent_id);

-- ---------------------------------------------------------------------------
-- Views: the derived reads
-- ---------------------------------------------------------------------------

-- What /api/orgs actually returns: 4 orgs. Explicit orgs come from the table;
-- self-orgs are synthesized here exactly as clients.py does on read, and the
-- underscore fixture is skipped exactly as list_orgs skips it.
create view org_membership as
select coalesce(o.slug, c.slug) as org_slug,
       coalesce(o.name, c.name) as org_name,
       c.id   as client_id,
       c.slug as client_slug,
       c.name as client_name
from clients c
left join orgs o on o.id = c.org_id
where left(c.slug, 1) <> '_'
  and c.deleted_at is null;

-- The fold over status_events. Replicates the engine's own summary:
--   * the LAST terminal line wins, read by ORDINAL (line_no), never by ts
--   * score is the last (eval,end) line carrying a non-null score
--   * iterations is the high-water mark of iter
--   * no terminal line at all means 'running', not 'failed'
-- Verified against the engine's summary across all 1,339 lines / 50 topics:
-- 0 mismatches on status, score, and iterations.
create view topic_rollup as
select t.id as topic_id,
       coalesce((select s.status from status_events s
                  where s.topic_id = t.id and s.status <> 'running'
                  order by s.line_no desc limit 1), 'running'::topic_status) as status,
       (select s.score from status_events s
         where s.topic_id = t.id and s.stage = 'eval' and s.event = 'end' and s.score is not null
         order by s.line_no desc limit 1) as score,
       coalesce((select max(s.iter) from status_events s where s.topic_id = t.id), 0) as iterations,
       (select count(*) from status_events s where s.topic_id = t.id) as event_count
from topics t;

-- has_blog is DERIVED, never stored. The engine treats the artifact's existence
-- as the truth about whether a topic has a blog, and a stored boolean re-encodes
-- that as something an operator's delete can silently falsify.
create view topics_live as
select t.*,
       exists (select 1 from blog_versions v where v.topic_id = t.id) as has_blog
from topics t
where t.deleted_at is null;

-- Staleness and answeredness as FK facts.
--
-- `blocking` deliberately DOES NOT consult the score, and its absence is the
-- rule rather than a simplification. It used to return "not blocking" at or
-- above the ship score, and that shipped two blogs at 96 over their own open
-- questions, one of them publishing a claim its canonical-facts file lists as
-- not citable. Answering is a DEMAND at every score. Measured: 4 topics are
-- currently done at 95/96 WITH current unanswered questions, and a score-based
-- formula reports every one of them as non-blocking.
create view v_review_notes as
select n.*,
       (n.blog_version_id <> (select v.id from blog_versions v
                               where v.topic_id = n.topic_id
                               order by v.version_no desc limit 1)) as stale,
       exists (select 1 from review_notes r where r.parent_id = n.id) as answered,
       (n.blog_version_id = (select v.id from blog_versions v
                              where v.topic_id = n.topic_id
                              order by v.version_no desc limit 1)
        and not exists (select 1 from review_notes r where r.parent_id = n.id)) as blocking
from review_notes n
where n.parent_id is null;

-- ---------------------------------------------------------------------------
-- Row Level Security: ON, with membership-scoped read policies
-- ---------------------------------------------------------------------------
-- The engine holds sb_secret_* and connects as the table owner, which BYPASSES
-- RLS entirely, so none of this affects a background run or the local engine:
-- adding these policies changes NOTHING about current behavior, exactly the
-- property this schema has always relied on. What RLS governs is the OTHER path,
-- a browser or Route Handler carrying an `authenticated` JWT straight to
-- Postgres. There, `anon` stays fully revoked (deny-all), and `authenticated`
-- gets SELECT-only, membership-scoped policies: an admin (a row in app_admins)
-- sees everything, an org member sees only their org's brands and those brands'
-- rows, and everyone else sees nothing. Writes never get a policy, so even a
-- stolen token cannot mutate. The auth_* predicate functions and the
-- security_invoker view flags that make this hold are defined below.
alter table orgs             enable row level security;
alter table clients          enable row level security;
alter table client_members   enable row level security;
alter table app_admins       enable row level security;
alter table org_members      enable row level security;
alter table client_resources enable row level security;
alter table roadmap_uploads  enable row level security;
alter table roadmap_sheets   enable row level security;
alter table roadmap_rows     enable row level security;
alter table topics           enable row level security;
alter table blog_versions    enable row level security;
alter table status_events    enable row level security;
alter table ledger_entries   enable row level security;
alter table review_notes     enable row level security;
alter table blog_comments    enable row level security;

-- Auth predicates (SECURITY DEFINER: read membership past the caller's own RLS,
-- using Supabase's auth.uid() = request.jwt.claims.sub).
create or replace function auth_is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_admins a where a.user_id = auth.uid())
$$;

create or replace function auth_org_slugs() returns setof client_slug
  language sql stable security definer set search_path = public as $$
  select om.org_slug from org_members om where om.user_id = auth.uid()
$$;

create or replace function auth_can_read_client(cid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select auth_is_admin()
      or exists (
        select 1 from org_membership m
        where m.client_id = cid
          and m.org_slug in (select auth_org_slugs())
      )
$$;

revoke all on function auth_is_admin(), auth_org_slugs(), auth_can_read_client(uuid) from anon;
grant execute on function auth_can_read_client(uuid) to authenticated;

-- Views must run as invoker or they leak (a view runs as its owner by default).
alter view org_membership set (security_invoker = true);
alter view topic_rollup   set (security_invoker = true);
alter view topics_live    set (security_invoker = true);
alter view v_review_notes set (security_invoker = true);

-- Read policies: authenticated + SELECT only. Row scope is the client_id the row
-- carries (or the row's own id for clients, the org slug for orgs).
create policy read_scoped on client_resources for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on roadmap_uploads  for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on roadmap_sheets    for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on roadmap_rows      for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on topics            for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on blog_versions     for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on status_events     for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on ledger_entries    for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on review_notes      for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on blog_comments     for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on clients for select to authenticated
  using (auth_can_read_client(id));
create policy read_scoped on orgs for select to authenticated
  using (auth_is_admin() or slug in (select auth_org_slugs()));
create policy self_or_admin on app_admins  for select to authenticated
  using (auth_is_admin() or user_id = auth.uid());
create policy self_or_admin on org_members for select to authenticated
  using (auth_is_admin() or user_id = auth.uid());

-- Table privilege behind the row filter. SELECT only; every write stays on the
-- service path. client_members is deliberately NOT granted: its per-brand
-- overlay is resolved in Python, never over the browser-direct path.
--
-- Only the tables with NO sensitive column get a table-wide grant. Everything else is
-- column-scoped below.
grant select on orgs, client_resources, roadmap_rows,
  org_membership, app_admins, org_members
  to authenticated;

-- ---------------------------------------------------------------------------
-- The client-safe column boundary (003, folded in here where fresh builds read it)
-- ---------------------------------------------------------------------------
-- RLS scopes ROWS to the caller's org and never COLUMNS, so a table-wide SELECT grant
-- hands every client login every column of every row it can see. seed_org_users.py mints
-- one authenticated login per client org and that JWT lives in the client's own browser: a
-- client could take it straight to `${SUPABASE_URL}/rest/v1/blog_versions?select=score,
-- eval_body` and read every score, hostile-audit eval body, research dossier, do-not-claim
-- fact base and status internal for their own brands. The portal's SELECT lists never ask
-- for those columns, but a SELECT LIST IS NOT A SECURITY CONTROL: a hand-crafted PostgREST
-- call ignores it. Migration 003 closed this on the live database and its header recorded
-- that it was never folded back here, so every fresh build reopened it, and phase 2 added
-- two operator emails (topics.sent_to_client_by, client_approved_by) to what leaked.
--
-- THE MODEL: revoke table-wide SELECT, then re-grant SELECT on the SAFE columns only.
-- PostgreSQL column privileges make a `select=score` by an authenticated JWT fail outright.
-- The revokes are load-bearing rather than decorative even on a virgin database: Supabase's
-- default privileges GRANT every newly created table in `public` to `authenticated`, so a
-- table this file creates arrives already open and has to be closed explicitly.
--
-- WHO IS UNAFFECTED: the local engine and the local admin dashboard reach Postgres as the
-- table OWNER over the service connection, which bypasses RLS and column grants entirely.
-- The hosted admin dashboard reads the admin-only views 003 provides for exactly that.

-- clients: the fact base (canonical_facts, which carries the do-not-claim list), the
-- internal brief (client_md) and the gate config (gates) are operator material. A client
-- sees only identity + flags.
revoke select on clients from authenticated;
grant select (id, org_id, slug, name, domain, industry, description,
              demo_mode, created_at, deleted_at, preflight_ok, is_fixture, canonical_facts_at)
  on clients to authenticated;

-- topics: the dossier, the links-verified working log, and the NEEDS_REVIEW marker text are
-- internal. Identity, title, ship pointer and timestamps are safe. The review-loop columns
-- (004, 005) join them: sent_to_client_at says when a blog was released, sent_version_id
-- names WHICH body the client reviews (and blog_versions.body is already theirs to read),
-- and client_approved_at records the client's own act. The two _by columns are person
-- emails, operator material, and stay off this list.
revoke select on topics from authenticated;
grant select (id, client_id, slug, title, shipped_version_id, created_at, deleted_at,
              sent_to_client_at, sent_version_id, client_approved_at)
  on topics to authenticated;

-- blog_versions: score and eval_body are the whole hostile-audit surface; iteration and
-- superseded_reason are pipeline internals. The article body and its metadata are the
-- client's own content and stay readable.
revoke select on blog_versions from authenticated;
grant select (id, topic_id, client_id, version_no, body, h1_title, word_count,
              shipped, committed_at)
  on blog_versions to authenticated;

-- status_events: score, note, stage, event, ts (run timing) are internals the contract
-- forbids. The portal folds client state from status + iter + line_no only, so those three
-- (plus the keys) are all it may read.
revoke select on status_events from authenticated;
grant select (id, topic_id, client_id, line_no, iter, status)
  on status_events to authenticated;

-- ledger_entries: the score column is the one internal; everything else is the ship record
-- the client's delivered library is built from.
revoke select on ledger_entries from authenticated;
grant select (id, client_id, topic_slug, topic, covers, prompts, generated_at, run_id)
  on ledger_entries to authenticated;

-- review_notes: asked_score is the score at asking time, an internal. The question text,
-- area, why, iteration and the reply rows are what the portal shows and records.
revoke select on review_notes from authenticated;
grant select (id, topic_id, client_id, blog_version_id, parent_id, author, author_id,
              ref, area, body, why, anchor, created_at, asked_iter)
  on review_notes to authenticated;

-- roadmap_sheets: raw_csv (the uploaded bytes) and report (the generation account) are
-- operator material. The portal reads roadmap_rows, not sheets, so grant only the harmless
-- identity columns for any incidental read.
revoke select on roadmap_sheets from authenticated;
grant select (id, client_id, filename, columns, modified, created_at)
  on roadmap_sheets to authenticated;

-- roadmap_uploads: the raw upload bytes. The portal never reads this table; revoke outright.
revoke select on roadmap_uploads from authenticated;

-- blog_comments (005). TWO columns stay out. author_email is a person's email address,
-- operator material on operator rows and another user's PII on client rows; a client
-- surface renders "you" or "the team" from author alone. applying_since is engine timing on
-- an operator's Claude session, which no client surface has any business reading: the
-- portal says "with the team" from state, and a visible apply clock would turn an internal
-- retry into something the client watches. parent_id IS granted, because the portal cannot
-- draw a thread without knowing which comment a reply hangs off. No INSERT or UPDATE grant
-- exists on purpose: client writes pass through the definer functions below, operator
-- writes ride the engine's owner connection, and a third path would be a write the comment
-- state machine never sees.
revoke select on blog_comments from authenticated;
grant select (id, topic_id, client_id, blog_version_id, parent_id, author, selected_text,
              context_before, context_after, instruction, state, error, edits,
              created_at, finished_at)
  on blog_comments to authenticated;

-- Views that re-expose sensitive base columns. The portal reads none of them (it reads base
-- tables with safe selects) and the hosted admin reads 003's admin-only views instead.
-- Revoke so an authenticated JWT cannot reach score/eval_body/dossier/asked_score through a
-- view either, which a view granted table-wide would hand over whole.
revoke select on topic_rollup   from authenticated;   -- score, iterations
revoke select on topics_live    from authenticated;   -- topics.* incl dossier/review_note
revoke select on v_review_notes from authenticated;   -- review_notes.* incl asked_score

-- ---------------------------------------------------------------------------
-- The client review writes (005): three SECURITY DEFINER gates
-- ---------------------------------------------------------------------------
-- The portal's suggest-changes, reply and approve actions, gated exactly as
-- portal_submit_answers (002/003) is: caller, body, membership parity, role, then the
-- topic's own state. SECURITY DEFINER because authenticated holds zero write grants, and
-- these functions are the doors a client write may pass through. Every error leaves as
-- 'PORTAL:<CODE>:<detail>' so the portal's route handler maps codes to HTTP statuses
-- without parsing prose.

-- Unlike a comment the admin files, NOTHING runs on insert here: the suggestion lands in
-- state 'open' and waits for an operator's Resolve, because an apply is a real Claude
-- session on an engine the client does not have.
--
-- AN APPROVED TOPIC IS NOT REFUSED. Approving is the client saying the article reads
-- right, not signing away their voice: someone who approves and then spots a wrong figure
-- must still be able to say so, and the alternative is a client emailing the team a
-- correction the record never sees. The admin gets a changes-requested chip on an approved
-- blog and decides. Only the send stamp gates: an article nobody released has nothing to
-- comment on.
create or replace function portal_suggest_change(
  p_brand       text,
  p_topic       text,
  p_selected    text,
  p_before      text,
  p_after       text,
  p_instruction text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text := coalesce(auth.jwt() ->> 'email', '');
  v_is_admin  boolean;
  v_is_member boolean;
  v_cid       uuid;
  v_tid       uuid;
  v_sent_at   timestamptz;
  v_sent_ver  uuid;
  v_open      int;
  v_id        uuid;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  if btrim(coalesce(p_selected, '')) = '' or btrim(coalesce(p_instruction, '')) = '' then
    raise exception 'PORTAL:BADBODY:a suggestion needs both the selected text and an instruction';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_brand and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1
          from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  -- The 003 parity rule: a non-member learns nothing, because a brand that does not
  -- exist and a brand in someone else's org answer identically.
  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  -- A member without the writing role is told so plainly: they can already see the
  -- brand, so this reveals nothing, and role vocabulary stays out of the message.
  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to suggest changes for this brand';
  end if;

  select t.id, t.sent_to_client_at, t.sent_version_id
    into v_tid, v_sent_at, v_sent_ver
  from topics t
  where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this article is not with you for review yet';
  end if;

  -- Serialize concurrent suggests on the topic row: two racing submits would otherwise
  -- both count nine open suggestions and both insert past the guard below.
  perform 1 from topics t where t.id = v_tid for update;

  -- The spam guard, counting TOP-LEVEL suggestions only. Ten unresolved suggestions on
  -- one article is not a review, it is a rewrite request, and every open row blocks Send
  -- again on the admin side: without a cap, one client could wedge an article's delivery
  -- indefinitely at zero cost. Replies are excluded because they ask for nothing: a thread
  -- of ten "thank you" notes must never spend the suggestion budget.
  select count(*) into v_open
  from blog_comments c
  where c.topic_id = v_tid and c.author = 'client'
    and c.parent_id is null and c.state in ('open', 'applying');
  if v_open >= 10 then
    raise exception 'PORTAL:LIMIT:ten suggestions are already with the team; they will follow up once those are addressed';
  end if;

  insert into blog_comments
    (topic_id, client_id, blog_version_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, v_sent_ver, 'client', v_email,
     p_selected, coalesce(p_before, ''), coalesce(p_after, ''), p_instruction, 'open')
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function portal_suggest_change(text, text, text, text, text, text)
  from public, anon;
grant execute on function portal_suggest_change(text, text, text, text, text, text)
  to authenticated;

-- A suggestion is not a one-shot form, it is the start of a thread: the admin resolves or
-- dismisses it and the client answers that, the admin answers back, and both sides read the
-- same rows. Same gate stack, with three refusals of its own.
--
-- A reply is DELIBERATELY NOT a change request. It inserts with parent_id set, state
-- 'open', its text in `instruction`, and empty selected_text, so no apply path can ever
-- pick it up and no count can ever see it. The reply-of-a-reply refusal is what keeps the
-- thread one level deep: the row constraint on blog_comments cannot read the parent's
-- parent_id, so the check lives here, and a client who somehow held a reply's id would
-- otherwise nest a conversation the rail has no way to draw.
create or replace function portal_reply_comment(
  p_brand  text,
  p_topic  text,
  p_parent uuid,
  p_body   text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_email        text := coalesce(auth.jwt() ->> 'email', '');
  v_is_admin     boolean;
  v_is_member    boolean;
  v_cid          uuid;
  v_tid          uuid;
  v_sent_at      timestamptz;
  v_parent_topic uuid;
  v_parent_of    uuid;
  v_replies      int;
  v_id           uuid;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'PORTAL:BLANK:a reply needs something in it';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_brand and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1
          from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  -- The 003 parity rule: a non-member learns nothing, because a brand that does not
  -- exist and a brand in someone else's org answer identically.
  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to reply for this brand';
  end if;

  select t.id, t.sent_to_client_at
    into v_tid, v_sent_at
  from topics t
  where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  -- An unsent article has no conversation to join. It refuses here rather than at the
  -- parent lookup so the client reads why, not "that comment does not exist".
  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this article is not with you for review yet';
  end if;

  -- Serialize on the parent row, for the reason suggest serializes on the topic: two
  -- racing replies would otherwise both count nineteen and both insert past the cap.
  select c.topic_id, c.parent_id into v_parent_topic, v_parent_of
  from blog_comments c
  where c.id = p_parent
  for update;

  -- An unknown comment, another topic's comment, and a REPLY all answer identically. The
  -- last one is not a lookup failure, it is the flat-thread rule: distinguishing it would
  -- also hand a caller a probe for which ids are replies.
  if v_parent_topic is null or v_parent_topic <> v_tid or v_parent_of is not null then
    raise exception 'PORTAL:NOTFOUND:no comment to reply to on this article';
  end if;

  -- Twenty replies on one comment is not a conversation any more. The suggestion cap
  -- above does not bind here (replies are excluded from it on purpose), so without this
  -- one the thread is an unbounded write channel behind an authenticated login.
  select count(*) into v_replies
  from blog_comments c
  where c.parent_id = p_parent;
  if v_replies >= 20 then
    raise exception 'PORTAL:LIMIT:this conversation is long enough; the team will follow up directly';
  end if;

  insert into blog_comments
    (topic_id, client_id, parent_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, p_parent, 'client', v_email,
     '', '', '', p_body, 'open')
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function portal_reply_comment(text, text, uuid, text) from public, anon;
grant execute on function portal_reply_comment(text, text, uuid, text) to authenticated;

-- Same gates as portal_suggest_change, then the stamp. Approval stays available while
-- the client's own suggestions are open (the portal keeps Approve live in the 'ready'
-- state), so there is deliberately no open-comment refusal here: approving over an open
-- suggestion is the client saying it no longer matters, and the admin dismisses it with
-- that context. Already-approved refuses rather than re-stamps, because the stamp
-- records WHEN the client accepted the release and a moving date falsifies that.
--
-- p_version IS THE VERSION THE CLIENT ACTUALLY READ, and it closes a real race: the team
-- presses Send again while the client's approval is in flight, mark_sent moves
-- sent_version_id to bytes nobody has seen, and the approval lands on them as though the
-- client had read them. An approval is a statement about specific text, so it refuses
-- (PORTAL:STALE) when the version it names is no longer the one on offer, and the portal
-- reloads and asks again. The client sees a refresh; the alternative is a signature on a
-- document that changed underneath it.
create or replace function portal_approve_blog(
  p_brand   text,
  p_topic   text,
  p_version uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text := coalesce(auth.jwt() ->> 'email', '');
  v_is_admin  boolean;
  v_is_member boolean;
  v_cid       uuid;
  v_tid       uuid;
  v_sent_at   timestamptz;
  v_sent_ver  uuid;
  v_approved  timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_brand and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1
          from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to approve for this brand';
  end if;

  select t.id, t.sent_to_client_at, t.sent_version_id, t.client_approved_at
    into v_tid, v_sent_at, v_sent_ver, v_approved
  from topics t
  where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this article is not with you for review yet';
  end if;
  if v_approved is not null then
    raise exception 'PORTAL:APPROVED:this article is already approved';
  end if;
  -- `is distinct from` and not `<>`, because either side can be null: a pre-005 send has
  -- no sent_version_id, and a portal that failed to read one sends null. Both are the
  -- same refusal, since neither can prove which bytes the client approved.
  if p_version is distinct from v_sent_ver then
    raise exception 'PORTAL:STALE:the team sent a newer version while you were reading; reload and take another look';
  end if;

  update topics
     set client_approved_at = now(),
         client_approved_by = v_email
   where id = v_tid;
end
$$;

revoke all on function portal_approve_blog(text, text, uuid) from public, anon;
grant execute on function portal_approve_blog(text, text, uuid) to authenticated;

-- A one-time REVOKE is point-in-time, and Supabase ships default privileges that
-- GRANT every LATER-created table to anon. Without this, the next migration
-- silently reopens the hole for tables that do not exist yet.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

commit;

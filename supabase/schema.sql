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
drop function if exists auth_can_read_client_slug(text)  cascade;
drop function if exists auth_can_write_client_slug(text) cascade;
drop function if exists auth_org_slugs()           cascade;
drop function if exists auth_is_admin()            cascade;
drop function if exists portal_submit_answers(text, text, jsonb) cascade;
drop function if exists portal_suggest_change(text, text, text, text, text, text) cascade;
drop function if exists portal_reply_comment(text, text, uuid, text) cascade;
drop function if exists portal_resource_add(text, text, text, bigint, text) cascade;
drop function if exists portal_resource_remove(text, text) cascade;
-- BOTH approve signatures. An earlier build of this file created the two-argument form,
-- and `create or replace` cannot change a signature: it adds an overload. Dropping only
-- the current one would leave a second, version-blind approve door callable forever, which
-- is exactly the stale-approval race the p_version argument exists to close.
drop function if exists portal_approve_blog(text, text, uuid) cascade;
drop function if exists portal_approve_blog(text, text) cascade;

-- 017's three. The two refuse_* functions back constraint triggers on tables this file already
-- drops above, so cascade reaches them for free; they are listed anyway, because a function this
-- file creates is a function this file owns and a teardown that skips one leaves a stale body
-- behind the day its signature changes. enforce_resources_prefix_quota is different and MUST be
-- here: its trigger sits on storage.objects, which this file never drops, so nothing else in the
-- teardown reaches it.
drop function if exists refuse_org_slug_collision()          cascade;
drop function if exists refuse_self_org_collision()          cascade;
drop function if exists enforce_resources_prefix_quota()     cascade;
drop function if exists resource_prefix_max_objects()        cascade;
drop function if exists resource_prefix_max_bytes()          cascade;

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
  -- Geography + language, e.g. "India, English": the location/language DataForSEO keyword
  -- validation runs against, and the market whose sources Agent R prefers. Collected at
  -- onboarding and editable from Settings (migration 026); sync.materialize_client splices it
  -- into client.md's Market section, which is where the agents read it.
  market      text not null default '',
  description text not null default '',

  -- The client doc set, inlined. An existing-but-empty doc must round-trip as ''
  -- and an absent one as NULL: collapsing the two loses which files exist, and
  -- canonical_facts being NULL rather than '' is what has_canonical_facts turns on.
  client_md       text,
  canonical_facts text,
  -- Stamped by sync.commit_client_facts when a facts build lands. Nullable
  -- exactly when canonical_facts is: an absent record has no build time.
  canonical_facts_at timestamptz,

  -- gates.json MINUS "organisation" (modelled by org_id above).
  gates       jsonb not null default '{}'::jsonb,

  -- The operator's standing blog instructions for this brand, edited from Settings and obeyed
  -- by the R/W/E agents as a MAJOR priority (above house style, never above canonical_facts).
  -- Operator material like client_md: protected by the column-scoped grant below, which does
  -- NOT list it. sync.materialize_client lays it down at clients/<slug>/custom-instructions.md.
  custom_instructions text not null default '',

  -- The CMS's own routing slug for this brand, when it differs from `slug` (migration 033). The
  -- publish payload's `client` field routes each draft to the CMS; it uses this when set and
  -- falls back to `slug` when blank. Operator material like custom_instructions: not in the
  -- authenticated re-grant below, so the hosted mirror cannot read it.
  cms_client text not null default '',

  -- WHERE this brand's finished blogs are published, and the credential that gets them there
  -- (migration 035). `{"kind": "strategi-cms"}` is the Strategi CMS, which every brand used
  -- before this column existed; `{"kind": "wordpress", "url": ..., "user": ..., "password": ...,
  -- "post_type": ...}` is the client's own website. An EMPTY object means no destination is
  -- configured, which the publish route refuses on rather than falling back to anything: an
  -- implicit fallback is what made "not configured" unnameable.
  --
  -- ONE jsonb, not a column per field, because the shape differs per platform and the column
  -- does not: adding a platform costs a driver file and no migration. `gates` is the precedent.
  --
  -- IT HOLDS A WRITE CREDENTIAL FOR A CLIENT'S LIVE WEBSITE, which makes it the most sensitive
  -- column here. Absent from the authenticated re-grant below like custom_instructions and
  -- cms_client, AND read by server/clients.py through its own query rather than _CLIENT_SELECT,
  -- because GET /api/clients/{slug} answers to require_user and everything in that select
  -- reaches any logged-in user.
  site jsonb not null default '{}'::jsonb,

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

-- ---------------------------------------------------------------------------
-- The org/brand slug invariant (017, folded in here)
-- ---------------------------------------------------------------------------
-- NO ROW IN clients WITH org_id NULL AND deleted_at NULL MAY HAVE A slug EQUAL TO ANY
-- orgs.slug. server/clients.py argues the why at length above `_self_org_clients`, and the
-- shape of it is this: a brand with org_id null synthesises its own slug as its org,
-- server/cms/routes.py turns that synthesised slug into STRATEGI_CMS_WRITE_KEY_<ORG>, and the
-- CMS derives the destination tenant FROM THE KEY. A brand `acme` with no org of its own is
-- handed the real org `acme`'s key, one client's blog lands in another client's CMS, and
-- neither side can notice, because the payload is forbidden from carrying a contradicting
-- org_id.
--
-- IT IS NOT A UNIQUE INDEX and no index can express it. An index spans one table and these
-- slugs live in two, and the invariant is not "the two namespaces are disjoint": a brand `acme`
-- whose org_id points at the org `acme` is the ordinary flagship case and is SAFE, because the
-- org_id is the operator's own statement that these are one tenant and the key that resolves is
-- that org's own. A union index forbids exactly that. The predicate is conditional on org_id,
-- so the check is too.
--
-- CONSTRAINT TRIGGERS, DEFERRED, because `_upsert_org` inserts the orgs row and THEN points the
-- client's org_id at it inside one transaction. Checked immediately, the orgs insert is judged
-- while the client still reads org_id null, so a legal final state fails at its halfway point.
-- Deferred to commit, either write order reaches the same answer.
--
-- SCOPED TO LIVE ROWS ON BOTH SIDES, which is what server/clients.py does, so this forbids
-- nothing the application allows. A soft-deleted brand cannot publish, cannot resolve a key and
-- cannot start a run, so its slug is dead weight in the org namespace and refusing to let an org
-- reuse it would strand that name forever for a row nobody can see. THE EXPOSURE IS AT UNDELETE
-- TIME, not at delete time, which is why the clients trigger lists deleted_at in its UPDATE OF
-- columns: a row that becomes live is re-checked at the moment it becomes live. There is no
-- undelete endpoint (server/clients.py: "reviving a dead slug is a decision for a human with
-- database access"), so a hand-written UPDATE is the exact caller this guard is for.
--
-- NEITHER TRIGGER VALIDATES EXISTING ROWS. Postgres checks a trigger only on rows written after
-- it exists, so a collision already in the record survives and is caught at read time by
-- server/clients.py's `synthesised_org_collides`, immediately before a key is resolved.
create or replace function refuse_org_slug_collision() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_brand text;
begin
  select c.slug into v_brand
    from clients c
   where c.slug = new.slug
     and c.org_id is null
     and c.deleted_at is null
   limit 1;

  if v_brand is not null then
    raise exception using
      errcode = '23514',
      message = format(
        'the organisation slug %L is already the slug of the brand %L, which has no '
        'organisation of its own', new.slug, v_brand),
      detail  = 'The two would resolve the same CMS write key, so one brand''s blog would '
                'publish into the other''s CMS and neither side of the request could notice.',
      hint    = 'Rename the organisation, or give that brand this organisation first.';
  end if;
  return null;
end $$;

create or replace function refuse_self_org_collision() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- Only a LIVE brand with NO org can break the invariant, so an org-bearing or soft-deleted
  -- brand leaves here. That early exit is what makes watching deleted_at cheap.
  if new.org_id is not null or new.deleted_at is not null then
    return null;
  end if;

  if exists (select 1 from orgs o where o.slug = new.slug) then
    raise exception using
      errcode = '23514',
      message = format(
        'the brand slug %L is already an organisation slug, so a brand with no organisation '
        'of its own would resolve that organisation''s CMS write key', new.slug),
      detail  = 'The brand would publish into that organisation''s CMS, and neither side of '
                'the request could notice, because the CMS derives the tenant from the key.',
      hint    = 'Give this brand an explicit organisation, or rename the organisation holding '
                'that slug. If this is an undelete, the collision was inert only while the '
                'brand was deleted.';
  end if;
  return null;
end $$;

-- UPDATE OF is a fire list, not a change test: the check is queued when the column appears in
-- the SET list, moved or not. slug is documented immutable and is listed anyway, because
-- "immutable" describes the application and this guard exists for the writers that are not it.
drop trigger if exists clients_no_org_slug_collision on clients;
create constraint trigger clients_no_org_slug_collision
  after insert or update of slug, org_id, deleted_at on clients
  deferrable initially deferred
  for each row execute function refuse_self_org_collision();

drop trigger if exists orgs_no_client_slug_collision on orgs;
create constraint trigger orgs_no_client_slug_collision
  after insert or update of slug on orgs
  deferrable initially deferred
  for each row execute function refuse_org_slug_collision();

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

-- sha256 READS LIKE AN INTEGRITY GUARANTEE AND IS NOT ONE, so it says so in the database rather
-- than only in a migration. The digest is computed in the BROWSER and shape-checked thereafter
-- and never again: SHA256_RE in the upload-url route and the identical regex in
-- portal_resource_add both prove 64 hex characters and nothing more, and no code in the portal
-- path re-reads the bytes to hash them. Re-hashing every object server-side is the complete
-- answer and the wrong trade, because it spends a full read of the corpus against a threat model
-- that is a logged-in member of the SAME tenant swapping one of their OWN documents, which that
-- member may simply do through the front door by deleting and re-uploading. Migration 017 part 3
-- argues it in full. What IS checked instead is the size, cross-checked in portal_resource_add
-- against the size Storage recorded, which costs one indexed lookup and closes the declare-it-as-
-- 1024-bytes move that the browser-direct upload opened.
comment on column client_resources.sha256 is
  'The sha256 the CLIENT asserted, computed in the browser. It is a content address and a '
  'deduplication key, NOT an integrity guarantee: nothing in the portal upload path re-reads '
  'the stored bytes to check it, so this column pins the KEY an object lives at and never the '
  'CONTENT behind it. supabase/migrate.py''s own push is the one path that verifies the digest '
  'by reading the object back. See migration 017 part 3.';

comment on column client_resources.size_bytes is
  'The size the client declared, cross-checked against the size Storage recorded whenever '
  'portal_resource_add can see the object row. Where it cannot, this is the client''s claim '
  'alone. The per-object cap that no caller can route around is storage.buckets.file_size_limit '
  '(015), not this column.';

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

-- One sheet per client PER MONTH. A brand holds one roadmap per `month` (a 1,2,3,...
-- sequence label the operator sees as "Month N Roadmap", NOT a calendar date). Every existing
-- sheet is Month 1. Measured before months: 5 sheets (acme-north has NO roadmap.csv).
--
-- The UNIQUE (client_id, month) is what allows the second, third, ... roadmap: it replaced the
-- old UNIQUE on client_id alone, which was the 409 the app returned on a second upload. The app
-- no longer refuses a second roadmap; it files it as the next month.
--
-- `raw_csv` holds the file byte-for-byte, and that is what makes the
-- raw-vs-built distinction lossless. read_sheet() returns the RAW rows for one sheet
-- (including a trailing blank row); load_roadmap()/_build_rows returns the INGESTABLE rows.
-- Both numbers are correct and describe different things. roadmap_rows stores the built rows;
-- the raw preview regenerates from raw_csv on demand. Neither is lost and the two cannot drift.
create table roadmap_sheets (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  -- 1-based sequence: Month 1 is the first roadmap added, Month 2 the next, and so on. Not a
  -- date. next_month() is max(month)+1, and a delete leaves gaps that are never reused.
  month      int not null default 1,
  filename   text not null,
  raw_csv    text not null,
  columns    text[] not null,
  -- roadmap-report.md for generated sheets; null for uploads.
  report     text,
  modified   timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, month)
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

  -- The CMS push (012). Written by server/cms/record.py AFTER the CMS accepts the article,
  -- and re-stamped on every push: payload.source_run_id addresses the same CMS post
  -- forever, so a second push updates it in place and the interesting fact is when the CMS
  -- last received these bytes.
  --
  -- NULL MEANS "NO RECORD OF A PUSH", NEVER "NOT PUBLISHED". Nothing recorded publishes
  -- before 012 and there was nothing to backfill from, so history starts there. A stamp
  -- that fails to write after a successful push leaves the same null. Every consumer
  -- renders the positive fact only and never states the negative.
  --
  -- cms_status is the CMS's own word for the post. It matters because a push answered
  -- `skipped` means a human already advanced that post past draft, so the article is live
  -- and pushing again will not move it, which calls for a different action than a draft.
  --
  -- published_by is an email and stays off the authenticated grants, like sent_to_client_by
  -- and client_approved_by. So do the three cms_ columns: they are our CMS's internals and
  -- no client surface renders them. The hosted admin reads them through admin_topics (003),
  -- which is gated on auth_is_admin().
  published_at timestamptz,
  published_by text,
  cms_post_id  text,
  cms_slug     text,
  cms_status   text,

  -- 035 pointed the push at the CLIENT'S OWN WEBSITE as well as at our CMS. The five columns
  -- above carry over unchanged, because a remote article has an id, a slug and a status
  -- wherever it lives and a blog goes to exactly ONE destination; the `cms_` prefix is now a
  -- legacy name for "the remote article". These two are what that prefix cannot cover.
  --
  -- cms_url is the published article's own URL AS THE DESTINATION REPORTED IT, never derived:
  -- permalink structure is a per-site setting, so building it from cms_slug would be a guess.
  -- Every create call returns the real link in the same response, so the honest value is free.
  --
  -- published_to is where THIS article went ('strategi-cms', or a host like 'acme.com').
  -- clients.site says where the brand publishes NOW; without this, changing that would rewrite
  -- the history of every article the brand ever published.
  cms_url      text,
  published_to text,

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
  -- The version the selection was made against: the topic's latest committed version at
  -- filing time for client suggestions (023; the portal renders the latest version to a
  -- client in review), null for engine-filed operator comments (their apply always
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
  -- When this comment was reframed and appended to the brand's custom instructions (025),
  -- or null. Stamped once by the engine; what keeps "Added to instructions" disabled
  -- across reloads and operators.
  added_to_instructions timestamptz,
  foreign key (topic_id, client_id) references topics(id, client_id) on delete cascade,
  -- ONE level of nesting. A parent_id row is 'open' and stays there, so nothing can
  -- resolve, apply, or dismiss it. The reply FEATURE is removed (025); parent_id rows
  -- still exist because portal_submit_answers stores a client's question answers this way,
  -- and historic replies keep rendering.
  constraint blog_comments_reply_open check (parent_id is null or state = 'open')
);

create index blog_comments_topic on blog_comments (topic_id, created_at);
-- Replies are read BY PARENT, one query for a whole page of threads. Without this index
-- that read is a sequential scan of the table on every stage-page poll, ten seconds apart.
create index blog_comments_parent on blog_comments (parent_id);

-- ---------------------------------------------------------------------------
-- Channel posts (031): a shipped blog repurposed into ONE channel-native piece (a LinkedIn
-- post, a Medium article), on their OWN track. Deliberately NOT topics/blog_versions/
-- blog_comments rows, so a channel post can never leak into a blog surface (the Blogs list,
-- blog_count, the ledger, the roadmap red-flags). One post per (source blog, channel). The
-- lifecycle mirrors a blog's delivery ladder minus everything a repurpose lacks: no score, no
-- eval, no evaluator questions, no ledger. See migration 031 for the full reasoning.
-- ---------------------------------------------------------------------------
create table channel_posts (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  source_topic_id uuid not null references topics(id) on delete cascade,
  channel         text not null check (channel in ('linkedin','medium')),
  body            text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  sent_to_client_at  timestamptz,
  sent_to_client_by  text,
  client_approved_at timestamptz,
  client_approved_by text,
  posted_at       timestamptz,
  posted_by       text,
  unique (source_topic_id, channel),
  unique (id, client_id)
);
create index channel_posts_client on channel_posts (client_id);
create index channel_posts_source on channel_posts (source_topic_id);

create table channel_post_comments (
  id              uuid primary key default gen_random_uuid(),
  channel_post_id uuid not null,
  client_id       uuid not null,
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
  applying_since  timestamptz,
  finished_at     timestamptz,
  foreign key (channel_post_id, client_id)
    references channel_posts(id, client_id) on delete cascade
);
create index channel_post_comments_post on channel_post_comments (channel_post_id, created_at);

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
-- `stale` is VERSION **OR** ITERATION, the one rule every reader of staleness now computes:
-- server/questions.py (describe_questions), the dashboard's portal-data.ts fold,
-- server/client_answers.py (_PENDING_SQL, which asks the complement and so reads "version
-- matches AND iteration matches"), and portal_submit_answers as replaced by migration 014.
--
-- The anchor leads because it is the stronger signal, for the reason stated at review_notes
-- itself: blog_version_id is NOT NULL with a composite FK, so it makes staleness an FK
-- comparison rather than an integer that resembles one. THE ITERATION ARM IS WHAT THIS VIEW
-- GAINED, and it is not redundant with the anchor: a RESTORE COMMITS NO NEW VERSION. The
-- stop-mid-revise path puts blog.md and eval.md back byte for byte, adding no blog_versions
-- row, so the anchor still matches while the iteration has moved past it. Version-only reads
-- that form as current, which is exactly the form the app refuses.
--
-- `is distinct from` on the iteration arm makes a row carrying no asked_iter stale, matching
-- what the app twins compute: a null form iter never equals the high-water integer.
--
-- Per ROW, not per form, which is this view's pre-existing shape: the app twins take the
-- form's iter as the first non-null asked_iter across the round. Nothing reads this view
-- today (it is revoked from authenticated and no query in the engine or dashboard names it),
-- so it is kept in step with the rule rather than being allowed to drift into a sixth,
-- disagreeing definition of the same word.
create view v_review_notes as
select n.*,
       (n.blog_version_id <> (select v.id from blog_versions v
                               where v.topic_id = n.topic_id
                               order by v.version_no desc limit 1)
        or n.asked_iter is distinct from
           coalesce((select max(s.iter) from status_events s
                      where s.topic_id = n.topic_id), 0)) as stale,
       exists (select 1 from review_notes r where r.parent_id = n.id) as answered,
       (n.blog_version_id = (select v.id from blog_versions v
                              where v.topic_id = n.topic_id
                              order by v.version_no desc limit 1)
        and n.asked_iter is not distinct from
            coalesce((select max(s.iter) from status_events s
                       where s.topic_id = n.topic_id), 0)
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

-- The SLUG-keyed pair (015, folded in here). Storage object keys carry the client SLUG in
-- their first path segment, never the client uuid, so a policy on storage.objects cannot
-- reuse auth_can_read_client. Same SECURITY DEFINER reasoning as its uuid sibling:
-- org_membership is a security_invoker view over clients, which carries its own RLS, so an
-- invoker function would answer a question about what the caller can SELECT rather than
-- about what they are a member of.
create or replace function auth_can_read_client_slug(cslug text) returns boolean
  language sql stable security definer set search_path = public as $$
  select auth_is_admin()
      or exists (
        select 1 from org_membership m
        where m.client_slug = cslug
          and m.org_slug in (select auth_org_slugs())
      )
$$;

-- The WRITE predicate. Admin-inclusive: a Strategi operator manages any brand's resources
-- from the console, and NOBODY ELSE. Resources are admin-only (024): a client never uploads,
-- deletes, lists or downloads a file. This is the ONE choke point every resource write routes
-- through (storage resources_insert_scoped and resources_delete_scoped, portal_resource_add,
-- portal_resource_remove), so admin-only here closes all four. cslug is now vestigial (an admin
-- may write any brand, a non-admin none), kept only because those four callers pass it.
create or replace function auth_can_write_client_slug(cslug text) returns boolean
  language sql stable security definer set search_path = public as $$
  select auth_is_admin()
$$;

revoke all on function auth_is_admin(), auth_org_slugs(), auth_can_read_client(uuid) from anon;
revoke all on function auth_can_read_client_slug(text), auth_can_write_client_slug(text)
  from anon;
grant execute on function auth_can_read_client(uuid) to authenticated;
grant execute on function auth_can_read_client_slug(text)  to authenticated;
grant execute on function auth_can_write_client_slug(text) to authenticated;

-- Views must run as invoker or they leak (a view runs as its owner by default).
alter view org_membership set (security_invoker = true);
alter view topic_rollup   set (security_invoker = true);
alter view topics_live    set (security_invoker = true);
alter view v_review_notes set (security_invoker = true);

-- Read policies: authenticated + SELECT only. Row scope is the client_id the row
-- carries (or the row's own id for clients, the org slug for orgs).
-- client_resources is admin-only (024): unlike every other read below, a client member never
-- sees a brand's fact-base index.
create policy read_scoped on client_resources for select to authenticated
  using (auth_is_admin());
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
grant select (id, org_id, slug, name, domain, industry, market, description,
              created_at, deleted_at, preflight_ok, is_fixture, canonical_facts_at)
  on clients to authenticated;

-- topics: the dossier, the links-verified working log, and the NEEDS_REVIEW marker text are
-- internal. Identity, title, ship pointer and timestamps are safe. The review-loop columns
-- (004, 005) join them: sent_to_client_at says when a blog was released, sent_version_id
-- names WHICH body the client reviews (and blog_versions.body is already theirs to read),
-- and client_approved_at records the client's own act. published_at (012) joins them as the
-- same shape of fact: a date something happened to this article. The three _by columns are
-- person emails, operator material, and stay off this list, and so do the cms_post_id,
-- cms_slug and cms_status columns, which are the remote system's internals.
--
-- cms_url and published_to (035) ARE granted, and the difference is what each one is: a public
-- article URL and a hostname, both rendered by the blog surfaces (the "View on acme.com" link
-- and the destination label). Neither carries a credential. Getting this wrong is not a missing
-- field, it is a 502 for every caller of any hosted route that selects them.
revoke select on topics from authenticated;
grant select (id, client_id, slug, title, shipped_version_id, created_at, deleted_at,
              sent_to_client_at, sent_version_id, client_approved_at, published_at,
              cms_url, published_to)
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
grant select (id, client_id, month, filename, columns, modified, created_at)
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

-- channel_posts / channel_post_comments (031): same boundary as the blog tables. The client
-- portal reads sent / approved / posted pieces and their comments; the _by person emails and
-- applying_since engine timing stay off the grant. RLS + column grants; the local engine and
-- local admin bypass both over the owner connection.
alter table channel_posts enable row level security;
alter table channel_post_comments enable row level security;
create policy read_scoped on channel_posts for select to authenticated
  using (auth_can_read_client(client_id));
create policy read_scoped on channel_post_comments for select to authenticated
  using (auth_can_read_client(client_id));
revoke select on channel_posts from authenticated;
grant select (id, client_id, source_topic_id, channel, body, created_at, updated_at,
              sent_to_client_at, client_approved_at, posted_at)
  on channel_posts to authenticated;
revoke select on channel_post_comments from authenticated;
grant select (id, channel_post_id, client_id, author, selected_text, context_before,
              context_after, instruction, state, error, edits, created_at, finished_at)
  on channel_post_comments to authenticated;

-- Views that re-expose sensitive base columns. The portal reads none of them (it reads base
-- tables with safe selects) and the hosted admin reads 003's admin-only views instead.
-- Revoke so an authenticated JWT cannot reach score/eval_body/dossier/asked_score through a
-- view either, which a view granted table-wide would hand over whole.
revoke select on topic_rollup   from authenticated;   -- score, iterations
revoke select on topics_live    from authenticated;   -- topics.* incl dossier/review_note
revoke select on v_review_notes from authenticated;   -- review_notes.* incl asked_score

-- ---------------------------------------------------------------------------
-- Admin-only full-column views for the HOSTED admin dashboard (003 + 006 + 007 + 008,
-- folded in here where fresh builds read them, and restored on the live DB by migration 030)
-- ---------------------------------------------------------------------------
-- These are the READ path for the hosted /api/me admin branch: listClients reads admin_clients,
-- readClient reads admin_topics_live, the ledger reads admin_ledger_entries, and so on. They
-- were dropped from this file at some consolidation (the 003 revokes above were folded in but
-- the views they hand admins were not), so every fresh build came up with an admin dashboard
-- that answered 502 and "Could not open your workspace." Definer views (security_invoker =
-- false) so they run as the owner and reach the columns 003 revoked, gated by auth_is_admin()
-- so a non-admin JWT gets zero rows and anon reaches them not at all. No base-table grant is
-- touched. `select *` so every column a later migration adds is carried automatically. The
-- LOCAL engine reads as the table owner and never touches these; only the hosted path does.
create or replace view admin_blog_versions  as select * from blog_versions  where auth_is_admin();
create or replace view admin_topics         as select * from topics         where auth_is_admin();
create or replace view admin_status_events  as select * from status_events  where auth_is_admin();
create or replace view admin_review_notes   as select * from review_notes   where auth_is_admin();
create or replace view admin_ledger_entries as select * from ledger_entries where auth_is_admin();
create or replace view admin_clients        as select * from clients        where auth_is_admin();
create or replace view admin_roadmap_sheets as select * from roadmap_sheets where auth_is_admin();

-- The two rollup views mirror topic_rollup and topics_live, bodies copied (not selected through
-- the revoked views) so one hop names which relation the rows come from.
create or replace view admin_topic_rollup as
  select
    t.id as topic_id,
    coalesce(
      (select s.status from status_events s
        where s.topic_id = t.id and s.status <> 'running'::topic_status
        order by s.line_no desc limit 1),
      'running'::topic_status) as status,
    (select s.score from status_events s
      where s.topic_id = t.id and s.stage = 'eval'::run_stage
        and s.event = 'end'::stage_event and s.score is not null
      order by s.line_no desc limit 1) as score,
    coalesce((select max(s.iter) from status_events s where s.topic_id = t.id), 0) as iterations,
    (select count(*) from status_events s where s.topic_id = t.id) as event_count
  from topics t
  where auth_is_admin();

create or replace view admin_topics_live as
  select
    t.id, t.client_id, t.slug, t.title, t.dossier, t.dossier_at, t.links_verified,
    t.review_note, t.shipped_version_id, t.created_at, t.deleted_at,
    exists (select 1 from blog_versions v where v.topic_id = t.id) as has_blog
  from topics t
  where t.deleted_at is null and auth_is_admin();

alter view admin_blog_versions  set (security_invoker = false);
alter view admin_topics         set (security_invoker = false);
alter view admin_status_events  set (security_invoker = false);
alter view admin_review_notes   set (security_invoker = false);
alter view admin_ledger_entries set (security_invoker = false);
alter view admin_clients        set (security_invoker = false);
alter view admin_roadmap_sheets set (security_invoker = false);
alter view admin_topic_rollup   set (security_invoker = false);
alter view admin_topics_live    set (security_invoker = false);

grant select on
  admin_blog_versions, admin_topics, admin_status_events, admin_review_notes,
  admin_ledger_entries, admin_clients, admin_topic_rollup, admin_topics_live,
  admin_roadmap_sheets
  to authenticated;

-- ---------------------------------------------------------------------------
-- The client answer write (002, hardened by 003, tightened by 014)
-- ---------------------------------------------------------------------------
-- portal_submit_answers is the client's ONE write in the question loop: the portal posts an
-- answer per question on the evaluator's current form, and this function records each answer
-- as a reply row under the question it answers. IT WAS NEVER IN THIS FILE AT ALL, which is the
-- same class of defect the column boundary above records for 003: the live database has held
-- it since 002 while every fresh build came up without the function the answer form posts to,
-- so a new teammate's database refused the one write the whole loop is built on. The body
-- below is 014's, because 014 is the current definition and no earlier one is worth
-- reproducing beside it.
--
-- STALENESS IS VERSION **OR** ITERATION, which is the same rule v_review_notes computes above
-- and the same rule the three application readers compute: server/questions.py
-- (describe_questions), the dashboard's portal-data.ts fold, and server/client_answers.py
-- (_PENDING_SQL, which asks the complement and so reads "version matches AND iteration
-- matches"). Five readers of one word, so a sixth definition here would be a disagreement
-- rather than a restatement.
--
-- THE ANCHOR LEADS because review_notes.blog_version_id is NOT NULL with a composite FK to
-- blog_versions(id, topic_id), so "these questions are about that exact draft" is a fact the
-- database enforces rather than an integer that resembles one. It was available to this
-- function from the beginning and went unread until 014, and a revise that commits a new
-- version while the iteration lands on the same number is what it catches.
--
-- THE ITERATION ARM IS NOT REDUNDANT WITH THE ANCHOR, and this is the part a reader is
-- tempted to drop on the FK's authority. A RESTORE COMMITS NO NEW VERSION: the stop-mid-revise
-- path puts blog.md and eval.md back byte for byte, so no blog_versions row is added and the
-- form's anchor still points at the topic's current version while the iteration has moved past
-- it. A version-only check reads that form as current and accepts answers about a draft the
-- blog has already moved on from, which is why the rule is OR rather than the pure anchor
-- comparison the FK would otherwise justify.
create or replace function portal_submit_answers(
  p_client_slug text,
  p_topic_slug  text,
  p_answers     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid             uuid := auth.uid();
  v_is_admin        boolean;
  v_is_member       boolean;
  v_cid             uuid;
  v_tid             uuid;
  v_form_version    uuid;
  v_current_version uuid;
  v_form_iter       int;
  v_current_iter    int;
  v_row             record;
  v_answer          text;
  v_missing         text[] := '{}';
  v_out             jsonb  := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'PORTAL:BADBODY:answers must be a JSON array of {id, answer}';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_client_slug and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1
          from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  -- A NON-MEMBER learns nothing: a brand that does not exist and a brand in someone else's
  -- org answer identically. This is the parity the read path already has (RLS folds both to
  -- an empty result), matched on the write path so the two cannot be told apart. 003 added
  -- this and it is carried forward here unchanged.
  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no blog to answer for this account';
  end if;

  -- A member who lacks the answering role is told so plainly: they can already see the brand,
  -- so this reveals nothing, and role vocabulary stays out of the message.
  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to answer for this brand';
  end if;

  select t.id into v_tid
  from topics t
  where t.client_id = v_cid and t.slug = p_topic_slug and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to answer for this account';
  end if;

  -- The current form: the latest asking round, exactly _db_form_rows' definition in
  -- server/questions.py. Older rounds are history, not the form.
  select n.blog_version_id into v_form_version
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
  order by n.created_at desc
  limit 1;
  if v_form_version is null then
    raise exception 'PORTAL:NOTFOUND:the evaluator asked nothing here';
  end if;

  -- Serialize concurrent submits on the form's parent rows: the loser of this lock
  -- re-reads after the winner commits and refuses below as already answered.
  perform 1
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
    and n.blog_version_id = v_form_version
  for update;

  -- The topic's current version, by version_no and not by committed_at: version_no carries
  -- unique (topic_id, version_no), so this ordering is total, while two rows can share a
  -- timestamp and leave "the current version" decided by whichever the planner returned.
  -- Every other reader of "the current draft" in this codebase selects it exactly this way.
  select v.id into v_current_version
  from blog_versions v
  where v.topic_id = v_tid
  order by v.version_no desc
  limit 1;

  select n.asked_iter into v_form_iter
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
    and n.blog_version_id = v_form_version and n.asked_iter is not null
  order by n.created_at, n.ref
  limit 1;

  select coalesce(max(s.iter), 0) into v_current_iter
  from status_events s
  where s.topic_id = v_tid;

  -- VERSION OR ITERATION, the rule this section's header states, in the order it argues it.
  -- The version arm fires only where a current version was actually found: v_current_version
  -- is null only if the topic has no blog_versions row at all, which the NOT NULL FK on the
  -- form's own anchor makes unreachable while a form exists, and refusing on a failed lookup
  -- would turn a missing row into a client who cannot answer anything.
  --
  -- `is distinct from` on the iteration arm is deliberate and pre-existing: a form carrying no
  -- asked_iter at all is stale, which is what the app twins compute too (a null form iter
  -- never equals the high-water integer).
  if (v_current_version is not null and v_form_version <> v_current_version)
     or (v_form_iter is distinct from v_current_iter) then
    raise exception 'PORTAL:STALE:these questions describe an earlier draft; the editorial team has since moved the article on';
  end if;

  if exists (
      select 1
      from review_notes n
      where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
        and n.blog_version_id = v_form_version
        and exists (select 1 from review_notes r where r.parent_id = n.id)) then
    raise exception 'PORTAL:ANSWERED:this form has already been answered';
  end if;

  for v_row in
    select n.id, n.client_id, n.blog_version_id, n.ref, n.body
    from review_notes n
    where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
      and n.blog_version_id = v_form_version
    order by n.created_at, n.ref
  loop
    select btrim(coalesce(a.elem ->> 'answer', '')) into v_answer
    from jsonb_array_elements(p_answers) a(elem)
    where a.elem ->> 'id' = v_row.ref
    limit 1;

    if v_answer is null or v_answer = '' then
      v_missing := v_missing || coalesce(v_row.ref, '?');
    else
      insert into review_notes
        (topic_id, client_id, blog_version_id, parent_id, author, author_id, body)
      values
        (v_tid, v_row.client_id, v_row.blog_version_id, v_row.id, 'client', v_uid, v_answer);
      v_out := v_out || jsonb_build_object(
        'id', v_row.ref, 'question', v_row.body, 'answer', v_answer);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'PORTAL:INCOMPLETE:%', array_to_string(v_missing, ',');
  end if;

  return jsonb_build_object(
    'slug', p_topic_slug,
    'answered_at', now(),
    'answers', v_out);
end
$$;

revoke all on function portal_submit_answers(text, text, jsonb) from public, anon;
grant execute on function portal_submit_answers(text, text, jsonb) to authenticated;

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
  v_latest    uuid;
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

  select t.id, t.sent_to_client_at
    into v_tid, v_sent_at
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

  -- The anchor: the topic's latest committed version, the same selection
  -- admin_send_blog_to_client (009) uses. The client in review reads the latest
  -- version, so this names the bytes the selection was actually made against.
  select v.id into v_latest
  from blog_versions v
  where v.topic_id = v_tid
  order by v.version_no desc
  limit 1;

  insert into blog_comments
    (topic_id, client_id, blog_version_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, v_latest, 'client', v_email,
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
-- portal_reply_comment is GONE (025): the reply feature is removed. A client files a
-- comment; the team resolves it with Claude or dismisses it. Historic reply rows keep
-- rendering, and portal_submit_answers still writes its answer rows with parent_id set.

-- Same gates as portal_suggest_change, then the stamp. Approval stays available while
-- the client's own suggestions are open (the portal keeps Approve live in the 'ready'
-- state), so there is deliberately no open-comment refusal here: approving over an open
-- suggestion is the client saying it no longer matters, and the admin dismisses it with
-- that context. Already-approved refuses rather than re-stamps, because the stamp
-- records WHEN the client accepted the release and a moving date falsifies that.
--
-- p_version IS THE VERSION THE CLIENT ACTUALLY READ, and that is the topic's LATEST
-- committed version (023), not sent_version_id: the race the STALE refusal closes is a
-- resolve committing a new version while the approval is in flight, landing the approval
-- on bytes nobody has seen. An approval is a statement about specific text, so it refuses
-- (PORTAL:STALE) when the version it names is no longer the newest committed one, and the
-- portal reloads and asks again. The client sees a refresh; the alternative is a
-- signature on a document that changed underneath it.
--
-- The stamp RE-PINS sent_version_id to the approved version: server/cms/gate.py publishes
-- from sent_version_id and refuses when it diverges from latest, and 013 locks an
-- approved article against further edits, so sent == approved == latest holds from the
-- stamp onward and the publish gate keeps meaning "nothing moved after the approval"
-- without changing a line of it.
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
  v_latest    uuid;
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

  select t.id, t.sent_to_client_at, t.client_approved_at
    into v_tid, v_sent_at, v_approved
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

  -- The topic's newest committed bytes, the same `order by version_no desc limit 1`
  -- selection admin_send_blog_to_client (009) uses to pick what a send releases.
  select v.id into v_latest
  from blog_versions v
  where v.topic_id = v_tid
  order by v.version_no desc
  limit 1;

  -- `is distinct from` and not `<>`, because either side can be null: a topic with no
  -- committed version has no latest, and a portal that failed to read one sends null.
  -- Both are the same refusal, since neither can prove which bytes the client approved.
  if p_version is distinct from v_latest then
    raise exception 'PORTAL:STALE:the team updated this article while you were reading; reload and take another look';
  end if;

  update topics
     set client_approved_at = now(),
         client_approved_by = v_email,
         sent_version_id    = p_version
   where id = v_tid;
end
$$;

revoke all on function portal_approve_blog(text, text, uuid) from public, anon;
grant execute on function portal_approve_blog(text, text, uuid) to authenticated;

-- Channel-post portal writes (032): the client requesting a change on, and approving, a
-- LinkedIn/Medium post. Mirror portal_suggest_change / portal_approve_blog exactly, minus the
-- version anchor and PORTAL:STALE (channel posts have no versions; the body is edited in place).
-- Keyed by (client slug, channel, source-blog slug), resolved to the post row inside the function.
create or replace function portal_suggest_channel_change(
  p_client_slug text,
  p_channel     text,
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
  v_pid       uuid;
  v_sent_at   timestamptz;
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
  where c.slug = p_client_slug and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1 from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to suggest changes for this brand';
  end if;

  select p.id, p.sent_to_client_at into v_pid, v_sent_at
  from channel_posts p
  join topics t on t.id = p.source_topic_id
  where p.client_id = v_cid and p.channel = p_channel
    and t.slug = p_topic and t.deleted_at is null;
  if v_pid is null then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this post is not with you for review yet';
  end if;

  perform 1 from channel_posts p where p.id = v_pid for update;

  select count(*) into v_open
  from channel_post_comments c
  where c.channel_post_id = v_pid and c.author = 'client'
    and c.state in ('open', 'applying');
  if v_open >= 10 then
    raise exception 'PORTAL:LIMIT:ten suggestions are already with the team; they will follow up once those are addressed';
  end if;

  insert into channel_post_comments
    (channel_post_id, client_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_pid, v_cid, 'client', v_email,
     p_selected, coalesce(p_before, ''), coalesce(p_after, ''), p_instruction, 'open')
  returning id into v_id;

  return v_id;
end
$$;

create or replace function portal_approve_channel_post(
  p_client_slug text,
  p_channel     text,
  p_topic       text
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
  v_pid       uuid;
  v_sent_at   timestamptz;
  v_approved  timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_client_slug and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1 from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to approve for this brand';
  end if;

  select p.id, p.sent_to_client_at, p.client_approved_at
    into v_pid, v_sent_at, v_approved
  from channel_posts p
  join topics t on t.id = p.source_topic_id
  where p.client_id = v_cid and p.channel = p_channel
    and t.slug = p_topic and t.deleted_at is null;
  if v_pid is null then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this post is not with you for review yet';
  end if;
  if v_approved is not null then
    raise exception 'PORTAL:APPROVED:this post is already approved';
  end if;

  update channel_posts
     set client_approved_at = now(),
         client_approved_by = v_email
   where id = v_pid;
end
$$;

revoke all on function portal_suggest_channel_change(text, text, text, text, text, text, text)
  from public, anon;
grant execute on function portal_suggest_channel_change(text, text, text, text, text, text, text)
  to authenticated;
revoke all on function portal_approve_channel_post(text, text, text) from public, anon;
grant execute on function portal_approve_channel_post(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The client resource write door (016, folded in here)
-- ---------------------------------------------------------------------------
-- The index half of a resource upload. The BYTES went browser -> Storage directly, governed by
-- 015's resources_insert_scoped, because Vercel's 4.5 MB body cap makes proxying a 25 MiB file
-- impossible. This function records the row that makes those bytes findable.
--
-- It is a function rather than an INSERT grant because `authenticated` holds SELECT and nothing
-- else on every table here, and RLS filters ROWS without stopping a caller from writing a row
-- that satisfies the filter. It reuses auth_can_write_client_slug (admins plus a brand's own
-- writing members) rather than answering that scope question a second time.
--
-- IT TAKES A SLUG AND A SHA, NEVER AN object_path. A caller-supplied path is the pointer to the
-- bytes themselves: `resources/<other-brand>/<sha>` would index another brand's private
-- document into this brand's knowledge base while passing every check that looked at client_id.
-- The path is BUILT from the brand this call is authorised for, so the only object a caller can
-- index is one they were permitted to upload.
--
-- A FILENAME ALREADY IN USE IS REFUSED AND NEVER UPSERTED, which is db.resource_add's rule and
-- this is the path its docstring was written for: the client uploads with no operator watching
-- the request, and an overwrite nobody sees silently changes what future blogs are written
-- from. Replacing a file is delete then upload, two visible acts.
create or replace function portal_resource_add(
  p_client_slug  text,
  p_name         text,
  p_sha256       text,
  p_size_bytes   bigint,
  p_content_type text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cid    uuid;
  v_path   text;
  v_other  text;
  v_out    jsonb;
  v_con    text;
  v_stored bigint;
begin
  if auth.uid() is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;

  -- Authorise before existence, the ordering 003 established: a refusal that differs by scope
  -- is an enumeration oracle. The predicate answers false for an unknown slug, a soft-deleted
  -- brand, a non-member and a viewer seat, and all four get this one sentence.
  if not auth_can_write_client_slug(p_client_slug) then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  select c.id into v_cid from clients c
   where c.slug = p_client_slug and c.deleted_at is null;
  if v_cid is null then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  -- Shape checks mirroring the table's constraints, so a malformed argument is a sentence
  -- rather than a check violation reaching the browser as a 500.
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'PORTAL:BLANK:a resource needs a filename';
  end if;
  if length(p_name) > 255 then
    raise exception 'PORTAL:BLANK:that filename is over 255 characters, which no filename is';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'PORTAL:BADBODY:sha256 must be 64 lowercase hex characters';
  end if;
  if p_size_bytes is null or p_size_bytes < 0 then
    raise exception 'PORTAL:BADBODY:size_bytes must be a non-negative byte count';
  end if;
  -- MAX_RESOURCE_BYTES, stated where a browser cannot route around it: the upload went
  -- straight to Storage, so no server of ours measured the file.
  if p_size_bytes > 26214400 then
    raise exception 'PORTAL:TOOLARGE:that file is over 25 MiB, which is the resource limit';
  end if;

  v_path := 'resources/' || p_client_slug || '/' || p_sha256;

  select cr.name into v_other from client_resources cr
   where cr.client_id = v_cid and cr.name = p_name;
  if v_other is not null then
    raise exception 'PORTAL:EXISTS:a resource named % already exists for this brand; delete it first or upload under a different name', p_name;
  end if;

  -- object_path is GLOBALLY unique and content-addressed, so one brand uploading identical
  -- bytes under two names collides with itself. (Two brands cannot collide: the slug is inside
  -- the path.) The clean outcome is to refuse and name the file it already is, because two rows
  -- sharing one object would be broken by the name-keyed delete, which removes the Storage
  -- object and would pull the bytes out from under the surviving row.
  select cr.name into v_other from client_resources cr where cr.object_path = v_path;
  if v_other is not null then
    raise exception 'PORTAL:DUPLICATEBYTES:this file is already stored for this brand as %; upload it once under the name you want', v_other;
  end if;

  -- THE DECLARED SIZE, CROSS-CHECKED AGAINST WHAT STORAGE MEASURED. Every number here arrives
  -- from the browser, and the TOOLARGE check above is therefore a check on a CLAIM rather than
  -- on a file: the upload went straight to Storage, so no server of ours weighed the bytes, and
  -- a client can PUT at the project default and then index it as 1024 bytes.
  -- storage.objects.metadata carries the size storage-api measured, so comparing the two costs
  -- one indexed lookup and no bytes at all.
  --
  -- INVISIBLE IS A PASS, and that is what makes this safe to add. The note below this function
  -- refuses to REQUIRE the object's existence, because a definer function's reach into
  -- storage.objects depends on whether its owner bypasses RLS: read an absence as a missing
  -- object and every upload is refused and the feature is dead. v_stored stays null for a
  -- missing row AND for an unreachable one, the two are indistinguishable, and both pass. Only a
  -- row this function can SEE, carrying a size that DISAGREES, is refused. The nested block is a
  -- subtransaction, so a lookup that RAISES for a privilege reason leaves through that same
  -- door. -1 marks a visible row whose metadata has no size yet, which happens while an upload
  -- is in flight, and it passes as an absence of evidence.
  --
  -- A match proves this row describes the object it points at. It proves NOTHING about
  -- p_sha256; see the comment on client_resources.sha256 above.
  begin
    select coalesce((o.metadata->>'size')::bigint, -1) into v_stored
      from storage.objects o
     where o.bucket_id = 'resources'
       and o.name = p_client_slug || '/' || p_sha256;
  exception
    when others then
      v_stored := null;
      raise warning 'portal_resource_add: could not read storage.objects for %/% (%: %); the declared size is NOT cross-checked', p_client_slug, p_sha256, sqlstate, sqlerrm;
  end;

  if v_stored is not null and v_stored >= 0 and v_stored <> p_size_bytes then
    raise exception 'PORTAL:BADBODY:the stored object is % bytes and this call declared %; upload the file again', v_stored, p_size_bytes;
  end if;

  insert into client_resources
    (client_id, name, object_path, sha256, size_bytes, content_type)
  values
    (v_cid, p_name, v_path, p_sha256, p_size_bytes, nullif(btrim(coalesce(p_content_type, '')), ''))
  returning jsonb_build_object(
              'name', name,
              'size', size_bytes,
              'modified', uploaded_at,
              'content_type', coalesce(content_type, ''))
       into v_out;
  return v_out;

exception
  -- The race db.resource_add leaves open (its own comment concedes it surfaces as a 500): two
  -- uploads of one filename milliseconds apart both pass the pre-checks and the index decides.
  -- Re-raised as the SAME code the pre-check uses, so a race and a plain duplicate are one
  -- answer. CONSTRAINT_NAME says which unique fired.
  when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'client_resources_object_path_key' then
      raise exception 'PORTAL:DUPLICATEBYTES:this file is already stored for this brand under another name; upload it once under the name you want';
    end if;
    raise exception 'PORTAL:EXISTS:a resource named % already exists for this brand; delete it first or upload under a different name', p_name;
end
$$;

-- DELIBERATELY NOT CHECKED: that the object exists in the bucket. A definer function's reach
-- into storage.objects depends on whether its owner bypasses RLS, and the failure direction is
-- the bad one: an empty read for a permissions reason refuses every upload and kills the
-- feature. An index row with no bytes behind it is a lesser fault, scoped to the brand that
-- created it and removable by the delete they already have. The size cross-check above does not
-- weaken that: it reads the same row and resolves the same uncertainty the other way round, so
-- an object it cannot see is ADMITTED and only a visible row with a contradicting size is
-- refused. Existence is still not required; a size that is present and wrong is simply no longer
-- accepted. The DIGEST remains unchecked in this path by design, argued on the sha256 column
-- comment above.

revoke all on function portal_resource_add(text, text, text, bigint, text) from public, anon;
grant execute on function portal_resource_add(text, text, text, bigint, text) to authenticated;

-- The matching REMOVE, and the reason a function has to mediate a delete the storage policy
-- below already authorises. resources_delete_scoped hands a client member a real capability over
-- the bytes: a browser holding it deletes the object from the bucket with no code of ours
-- involved. It cannot delete the matching INDEX row by any path that exists, because
-- `authenticated` holds SELECT and nothing else on client_resources. So the policy alone grants
-- exactly half a delete, and the destructive half: the bytes are gone, the row is still listed,
-- and the download route answers 502 for a file the client believes they removed.
--
-- Both halves happen HERE, in one call and one transaction, so the two cannot diverge. This does
-- not take the raw capability away and is not meant to, since a client who deletes the object
-- directly still strands the row and no database rule stops them. It makes the whole delete the
-- easy path and the only one the portal offers, which is the difference between a divergence that
-- happens by accident and one someone has to go out of their way to cause.
--
-- IT TAKES A SLUG AND A NAME, NEVER AN object_path, for the reason portal_resource_add states
-- above and with more force: here the path would point at bytes this function DELETES with the
-- definer's own authority, so `resources/<other-brand>/<sha>` would destroy another client's
-- document. The path used below is the one already recorded on the row this call was authorised
-- to remove.
create or replace function portal_resource_remove(
  p_client_slug text,
  p_name        text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cid    uuid;
  v_path   text;
  v_bucket text;
  v_key    text;
  v_gone   int;
begin
  if auth.uid() is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;

  -- Authorise before existence, the ordering portal_resource_add uses above: a refusal that
  -- differs by scope is an enumeration oracle. The predicate answers false for an unknown slug,
  -- a soft-deleted brand, a non-member and a viewer seat, and all four get this one sentence.
  if not auth_can_write_client_slug(p_client_slug) then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  select c.id into v_cid from clients c
   where c.slug = p_client_slug and c.deleted_at is null;
  if v_cid is null then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  -- NO SHAPE CHECKS ON p_name, and the asymmetry with portal_resource_add is deliberate. Those
  -- exist there because that function WRITES, so a blank or over-long name would reach the
  -- browser as a check-constraint 500 rather than a sentence. This one only MATCHES: a name
  -- blank, over-long, or simply not one of this brand's matches no row and earns the same
  -- refusal, and one sentence for every miss is what keeps it from saying which miss was hit.
  --
  -- Keyed on (client_id, name), the pair the unique constraint uses, so this deletes one row or
  -- none. object_path comes back from the row itself, which is what makes the storage half safe:
  -- it is a value this call just proved the caller owns.
  delete from client_resources cr
   where cr.client_id = v_cid and cr.name = p_name
   returning cr.object_path into v_path;
  if v_path is null then
    raise exception 'PORTAL:NOTFOUND:no resource named % for this brand', p_name;
  end if;

  -- object_path carries the bucket prefix (`resources/<slug>/<sha256>`) while storage.objects
  -- keys an object WITHOUT it, so the first segment is split off exactly as server/app.py and
  -- sync.materialize_client split it. On the FIRST slash only, because the key contains a slash
  -- of its own and has to survive intact. The bucket is read from the path rather than hardcoded
  -- so a row written under a different bucket cannot have its key applied to this one.
  v_bucket := split_part(v_path, '/', 1);
  v_key    := substr(v_path, length(v_bucket) + 2);

  -- A MISSING OBJECT IS NOT AN ERROR, and it must not be. portal_resource_add says plainly that
  -- it does not verify the bytes exist before indexing them, so an index row with nothing behind
  -- it is an admitted state of this system. Raising on a zero row count would make that row
  -- permanently undeletable, leaving a listing entry the client can neither download nor remove.
  --
  -- Whether this function reaches storage.objects at all depends on whether its owner bypasses
  -- RLS, the same uncertainty the note under portal_resource_add names, and that uncertainty
  -- resolves into TWO DIFFERENT FAILURES rather than one. Conflating them is what put a bug here:
  --
  --   RLS FILTERS THE ROW. A legal statement matches nothing, row_count is 0, the index row still
  --   goes, the object is orphaned, and the function returns object_removed = false. That is the
  --   state the system is already in today, so the false makes it visible rather than silent.
  --
  --   THE OWNER LACKS THE DELETE PRIVILEGE. The statement does not come back empty, it RAISES,
  --   and unhandled that raise aborted the function and rolled the index delete back with it, so
  --   the client read an error and the resource could not be removed by any path the product
  --   offers: the permanently undeletable row the rule above refuses to cause, from the far side.
  --
  -- The nested block makes the second case leave through the first case's signal. A plpgsql block
  -- with an exception clause is a subtransaction, so a raise rolls back to the block's entry and
  -- no further, and the index delete the product's readers depend on survives the storage half
  -- failing. `others` is caught deliberately: every way this statement raises is a way the object
  -- did not get removed, which is exactly what the return value says, and the warning carries the
  -- SQLSTATE to the log so one false does not hide three causes. v_gone is assigned 0 because the
  -- raise precedes `get diagnostics`, and a null v_gone would return JSON null for a boolean.
  begin
    delete from storage.objects o
     where o.bucket_id = v_bucket and o.name = v_key;
    get diagnostics v_gone = row_count;
  exception
    when others then
      v_gone := 0;
      raise warning 'portal_resource_remove: storage delete of %/% failed (%: %); the index row is removed and the object is orphaned', v_bucket, v_key, sqlstate, sqlerrm;
  end;

  -- The OUTER block has no exception handler, unlike portal_resource_add, because there is no
  -- constraint here to violate: two callers removing one name concurrently is already correct,
  -- one delete returning the row and the other raising NOTFOUND. The handler above is scoped to
  -- the storage statement alone, because widening it would swallow that NOTFOUND and the
  -- authorisation refusals, which the caller has to see.
  return jsonb_build_object('name', p_name, 'object_removed', v_gone > 0);
end
$$;

-- WHAT "DELETING THE OBJECT" MEANS HERE, PRECISELY. Supabase Storage keeps an object's metadata
-- in storage.objects and its bytes in the backing store, and it is the storage.objects row every
-- reader resolves: the signed-URL route, a direct download and a bucket listing all answer
-- not-found the moment the row is gone. Removing the row is a complete delete as far as this
-- product, its clients and its agents can observe. What it does not do is remove the stored
-- bytes, so a blob no row references can survive in the backing store. It costs storage, it is
-- content-addressed, and it is unreachable without a row pointing at it, which is a far smaller
-- fault than the index and the bucket disagreeing about what a client owns.

revoke all on function portal_resource_remove(text, text) from public, anon;
grant execute on function portal_resource_remove(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The approved lock (013). An approved article is locked, for everyone.
-- ---------------------------------------------------------------------------
-- The approval stamp records that the client accepted THESE BYTES. Any edit after it makes the
-- record assert something the client never did: they approved v4, the article is now v6, and
-- nothing distinguishes the two. Posting to the CMS is the one act left, because it changes
-- nothing about the article.
--
-- TRIGGERS RATHER THAN A CHECK IN EACH WRITER, because there are five write paths into an
-- article and they share no chokepoint: two SQL functions on the hosted build, two Python
-- functions in the engine, and the runner committing a version at the end of a generate.
-- Guarding the SQL half would lock the hosted build and leave the engine free to overwrite an
-- approved article, which is the worse half to leave open, since the engine is where the
-- writing happens. A trigger is the only guard all five must pass.
--
-- REPLIES ARE EXEMPT, which is what `parent_id is not null` buys. A reply changes no bytes and
-- resolves nothing, so "thanks, this reads well" is not an edit, and refusing it only buys
-- silence from a client who has just been told their article is finished.
create or replace function refuse_version_when_approved()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_approved timestamptz;
begin
  select t.client_approved_at into v_approved from topics t where t.id = new.topic_id;
  if v_approved is not null then
    raise exception
      'PORTAL:LOCKED:the client approved this article on %, so it is locked and cannot be '
      'changed. Posting it to the CMS is the only act left.',
      to_char(v_approved, 'DD Mon YYYY');
  end if;
  return new;
end
$$;

drop trigger if exists blog_versions_approved_lock on blog_versions;
create trigger blog_versions_approved_lock
  before insert on blog_versions
  for each row execute function refuse_version_when_approved();

create or replace function refuse_comment_when_approved()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_approved timestamptz;
begin
  if new.parent_id is not null then
    return new;
  end if;
  select t.client_approved_at into v_approved from topics t where t.id = new.topic_id;
  if v_approved is not null then
    raise exception
      'PORTAL:LOCKED:this article was approved on % and is locked, so it cannot take new '
      'change requests. Replies to existing threads still work.',
      to_char(v_approved, 'DD Mon YYYY');
  end if;
  return new;
end
$$;

drop trigger if exists blog_comments_approved_lock on blog_comments;
create trigger blog_comments_approved_lock
  before insert on blog_comments
  for each row execute function refuse_comment_when_approved();

-- ---------------------------------------------------------------------------
-- Storage RLS for the Resources bucket (015, folded in here)
-- ---------------------------------------------------------------------------
-- Vercel caps a serverless request body at 4.5 MB on every plan and MAX_RESOURCE_BYTES is
-- 25 MiB, so a resource upload CANNOT be proxied through a Route Handler: the platform
-- rejects it before our code runs. The browser therefore talks to Storage directly with the
-- signed-in user's JWT, and these policies are the only thing standing between one client's
-- private documents and another's. db.resource_add writes bytes at `<client_slug>/<sha256>`
-- inside bucket `resources`, so the scope key is the FIRST PATH SEGMENT.
--
-- The storage schema is created by supabase/storage-api, not by this file. Fail with the
-- reason rather than with a bare "relation does not exist", exactly as the version check does.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception
      'geo-factory storage policies need the Supabase storage schema; storage.objects was '
      'not found. This schema targets a Supabase database, not bare Postgres.';
  end if;
end $$;

-- storage-api resolves the bucket row on the CALLER's connection for several object
-- operations, so with no policy an upload fails as bucket-not-found rather than as a
-- permissions error. This exposes one row and only the fact that a private bucket named
-- `resources` exists. It grants no reach over any OBJECT.
drop policy if exists resources_bucket_visible on storage.buckets;
create policy resources_bucket_visible on storage.buckets for select to authenticated
  using (id = 'resources');

-- The 25 MiB cap, stated where Storage itself enforces it. The insert policy below is what
-- makes this line necessary: once the browser PUTs to Storage directly, no server of ours ever
-- weighs the bytes, and portal_resource_add's size check runs AFTER the upload has landed and
-- reads a number the BROWSER supplied, so it is not a cap on the upload at all. A client can
-- PUT at the project default, which is 50 MB on a new project, then never call the index RPC
-- or call it declaring 1024 bytes, and an object nobody indexed is invisible to every query
-- this app makes.
--
-- file_size_limit is checked by storage-api during the upload, before any SQL of ours runs and
-- against the bytes themselves rather than against a claim about them, which makes it the only
-- statement of this limit a caller cannot route around. 26214400 is MAX_RESOURCE_BYTES in
-- server/clients.py and the bound on the client_resources.size_bytes check constraint above;
-- the three move together or the smallest one silently becomes the real cap.
--
-- NO allowed_mime_types, DELIBERATELY. A resource corpus is a client's knowledge base and is
-- heterogeneous by design, and the set is open because the next client arrives with a format
-- no list written today predicted, so an allowlist would reject documents a client is entitled
-- to upload and the failure would look like a broken portal rather than a policy. It would buy
-- little in return: a MIME type is a header the caller sends rather than a property of the
-- bytes, so relabelling the file defeats it. Size is the opposite, being the one property of an
-- upload that cannot be misdeclared to Storage, so it carries this alone.
--
-- An UPDATE and not an INSERT, because supabase/migrate.py owns creating this bucket and a
-- second creator here would race it. ZERO ROWS IS THE NORMAL FRESH-BUILD OUTCOME rather than a
-- failure: this file runs BEFORE upload_resources creates the bucket, so raising would break
-- every fresh build, and migrate.py's create payload carries this same number so such a project
-- is born with the cap already set. The notice exists because the other way to reach zero rows
-- is a live database where the cap is now NOT set, and that must never pass silently.
do $$
declare
  n_buckets int;
begin
  update storage.buckets set file_size_limit = 26214400 where id = 'resources';
  get diagnostics n_buckets = row_count;
  if n_buckets = 0 then
    raise notice
      'no file_size_limit was set: no row of storage.buckets matched id = ''resources''. '
      'Either the bucket does not exist yet, which is EXPECTED here because this file runs '
      'before supabase/migrate.py creates it carrying the same 26214400 limit, or this role '
      'cannot reach storage.buckets, which is owned by supabase_storage_admin. On a live '
      'database the second case means the 25 MiB cap is UNSET and a client can upload at the '
      'project default; re-run this statement from the Supabase SQL editor.';
  end if;
end $$;

-- Every policy is scoped to bucket_id = 'resources' FIRST, so it never governs a bucket this
-- project adds later. (storage.foldername(name))[1] is matched by EQUALITY against a slug the
-- caller holds membership for: no wildcard and no prefix match, so `acme` and `acme-holdings`
-- are unrelated values and a caller with no membership satisfies nothing.
--
-- SELECT is ADMIN-ONLY (024): only the admin console lists or downloads a brand's knowledge
-- base. auth_can_write_client_slug (redefined to admin-only) would serve here too, but the read
-- side reuses no membership predicate, so auth_is_admin() is stated directly.
drop policy if exists resources_read_scoped on storage.objects;
create policy resources_read_scoped on storage.objects for select to authenticated
  using (
    bucket_id = 'resources'
    and auth_is_admin()
  );

-- INSERT and DELETE are admin-only (024) via auth_can_write_client_slug.
-- The depth check exists because storage
-- keys are literal strings never validated against the client_slug domain: `mine/../yours/x`
-- has first segment `mine`, so it could never be read as another brand's, but every
-- legitimate key is exactly one folder deep and requiring that removes the question.
drop policy if exists resources_insert_scoped on storage.objects;
create policy resources_insert_scoped on storage.objects for insert to authenticated
  with check (
    bucket_id = 'resources'
    and array_length(storage.foldername(name), 1) = 1
    and auth_can_write_client_slug((storage.foldername(name))[1])
  );

drop policy if exists resources_delete_scoped on storage.objects;
create policy resources_delete_scoped on storage.objects for delete to authenticated
  using (
    bucket_id = 'resources'
    and auth_can_write_client_slug((storage.foldername(name))[1])
  );

-- ---------------------------------------------------------------------------
-- The per-brand bound on the bucket (017 part 2, folded in here)
-- ---------------------------------------------------------------------------
-- file_size_limit above caps ONE object in ONE upload and says nothing about how many objects
-- there are. A member with a write seat satisfies resources_insert_scoped for every key under
-- their own slug, and the keys are content-addressed, so distinct bytes are distinct keys with
-- nothing to collide against. That member can PUT 25 MiB at a time without end and never call
-- portal_resource_add once.
--
-- UNINDEXED OBJECTS ARE THE WHOLE PROBLEM. Everything in this product reads the INDEX:
-- client_resources drives the portal list, sync.materialize_client, the signed-URL route and the
-- admin console. An object nobody indexed appears in none of them and is UNRECLAIMABLE by any
-- path the product offers, because portal_resource_remove is keyed on a client_resources row and
-- there is no row. So the bound goes on storage.objects and not on client_resources: every
-- indexed resource has an object, so bounding the bucket bounds both, and it is the only one of
-- the two that reaches what nobody declared.
--
-- THE TWO NUMBERS ARE DEFAULTS, NOT REQUIREMENTS, and they are functions so there is one place
-- to change each. The measured corpus is 5 files and about 12.8 MB across two brands, largest
-- file 12.8 MB, so these sit roughly fifty times above it by count and eighty times by bytes:
-- far enough that no legitimate client meets one, near enough that the abuse case stops being
-- unbounded. They are not redundant. The BYTE cap is what anyone actually cares about and what
-- binds in practice; the OBJECT cap is what still holds when the byte sum cannot be computed and
-- what bounds a flood of tiny objects that costs little and makes the bucket unlistable.
create or replace function resource_prefix_max_objects() returns bigint
  language sql immutable as $$ select 250::bigint $$;

create or replace function resource_prefix_max_bytes() returns bigint
  language sql immutable as $$ select 1073741824::bigint $$;   -- 1 GiB

comment on function resource_prefix_max_objects() is
  'Per-brand object cap for the resources bucket. Enforced by resources_prefix_quota.';
comment on function resource_prefix_max_bytes() is
  'Per-brand byte cap for the resources bucket. Enforced by resources_prefix_quota.';

create or replace function enforce_resources_prefix_quota() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_prefix   text;
  v_objects  bigint;
  v_bytes    bigint;
  v_max_obj  bigint := resource_prefix_max_objects();
  v_max_byte bigint := resource_prefix_max_bytes();
begin
  -- Scoped to this bucket FIRST, for the same reason every policy above is: a rule written for
  -- this feature must not quietly govern every bucket this project adds later.
  if new.bucket_id is distinct from 'resources' then
    return new;
  end if;

  v_prefix := (storage.foldername(new.name))[1];
  if v_prefix is null then
    -- A key with no folder segment belongs to no brand, so no per-brand bound applies.
    -- resources_insert_scoped already refuses such a key for every `authenticated` caller, so
    -- the only writer reaching this line is the secret key, which is ours.
    return new;
  end if;

  -- THE FIGURES COME FROM THE ROWS ALREADY PRESENT, so the object being inserted is in neither,
  -- and the effective ceiling is one object and one file_size_limit above the stated caps. That
  -- is deliberate: a BEFORE INSERT trigger sees a row whose metadata storage-api has not written
  -- yet, so NEW carries no trustworthy size, and a quota computed from a caller-supplied number
  -- is not a quota. A 25 MiB overshoot on a 1 GiB cap is noise.
  --
  -- `o.name <> new.name` because storage-api can re-insert a key already present, and counting
  -- it twice would refuse a re-upload of something the brand already owns. coalesce is on the
  -- ELEMENT as well as the sum: metadata lands after the upload does, so an in-flight object
  -- contributes null and would otherwise null the whole sum and disable the byte cap for as long
  -- as any upload is open.
  begin
    select count(*),
           coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)
      into v_objects, v_bytes
      from storage.objects o
     where o.bucket_id = 'resources'
       and (storage.foldername(o.name))[1] = v_prefix
       and o.name <> new.name;
  exception
    when others then
      -- A QUOTA MUST NEVER TAKE DOWN AN UPLOAD FOR A REASON THAT IS NOT A QUOTA. Whether this
      -- function can read storage.objects depends on whether its OWNER bypasses RLS on a table
      -- owned by supabase_storage_admin, the same uncertainty portal_resource_add names. If the
      -- read raises, the object is admitted, which is exactly the behaviour before this existed.
      -- The warning carries the SQLSTATE, because a silent degradation is a control that is not
      -- there and nobody knows it.
      raise warning
        'resources_prefix_quota could not read storage.objects for prefix % (%: %); the object '
        'is admitted and the per-brand bound is NOT in force', v_prefix, sqlstate, sqlerrm;
      return new;
  end;

  if v_objects >= v_max_obj then
    raise exception using
      errcode = '53400',
      message = format(
        'the brand %L already holds %s objects in the resources bucket, which is its limit of %s',
        v_prefix, v_objects, v_max_obj),
      hint = 'Delete resources this brand no longer needs, or raise '
             'resource_prefix_max_objects() in supabase/schema.sql.';
  end if;

  if v_bytes >= v_max_byte then
    raise exception using
      errcode = '53400',
      message = format(
        'the brand %L already holds %s bytes in the resources bucket, which is its limit of %s',
        v_prefix, v_bytes, v_max_byte),
      hint = 'Delete resources this brand no longer needs, or raise '
             'resource_prefix_max_bytes() in supabase/schema.sql.';
  end if;

  return new;
end $$;

-- BEFORE and not AFTER, and a plain trigger rather than a constraint trigger: this is a resource
-- bound on one statement, checked before the statement does anything, which is the only point at
-- which refusing it is cheap. IT GOVERNS THE SECRET KEY TOO, correctly: RLS bypass is not
-- trigger bypass, so migrate.py's own bulk push is bounded by the same numbers, and a quota the
-- operator's tooling is exempt from is a quota discovered by an operator's mistake.
drop trigger if exists resources_prefix_quota on storage.objects;
create trigger resources_prefix_quota
  before insert on storage.objects
  for each row execute function enforce_resources_prefix_quota();

-- NO UPDATE POLICY, DELIBERATELY. An UPDATE on storage.objects governs overwriting a key
-- (x-upsert) and moving one. Objects here are content-addressed at `<slug>/<sha256>`, so
-- different bytes are a different key and an overwrite could never legitimately change
-- anything. The product rule agrees from the other end: a duplicate filename WARNS AND IS
-- REJECTED, never overwritten, and an UPDATE policy would hand the browser exactly the
-- overwrite that rule forbids. Replacing a resource is delete then insert, two visible acts.

-- A one-time REVOKE is point-in-time, and Supabase ships default privileges that
-- GRANT every LATER-created table to anon. Without this, the next migration
-- silently reopens the hole for tables that do not exist yet.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- ---------------------------------------------------------------------------
-- Monthly GEO performance reports (020, folded in here for fresh builds)
-- ---------------------------------------------------------------------------
-- One per brand per CALENDAR month (YYYY-MM). WORKING copy (report/pdf/generated_at) is the
-- operator's, shown in the admin dashboard, served as a PDF, removed by Delete. SHARED snapshot
-- (shared_report/shared_pdf/shared_at) is the client's, set by Share, immutable to Generate and
-- surviving a working Delete so a client keeps seeing the last sent report. Regenerating after a
-- share leaves generated_at > shared_at, read as "not shared yet". RLS on, all authenticated
-- grants revoked: the local engine reads over the owner connection, the hosted site ONLY through
-- the definer functions below. See 020_client_reports.sql for the full account.
create table if not exists client_reports (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  month         text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  report        jsonb,
  pdf           bytea,
  generated_at  timestamptz,
  generated_by  text,
  shared_report jsonb,
  shared_pdf    bytea,
  shared_at     timestamptz,
  shared_by     text,
  created_at    timestamptz not null default now(),
  unique (client_id, month)
);
create index if not exists client_reports_client on client_reports (client_id);
alter table client_reports enable row level security;
revoke all on client_reports from authenticated, anon;

create or replace function report_months(p_brand text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(
           jsonb_build_object('month', r.month, 'shared_at', r.shared_at,
                              'report', r.shared_report, 'has_pdf', (r.shared_pdf is not null))
           order by r.month desc), '[]'::jsonb)
  from client_reports r
  join clients c on c.id = r.client_id
  where c.slug = p_brand
    and r.shared_at is not null
    and r.shared_report is not null
    and auth_can_read_client_slug(p_brand);
$$;

create or replace function report_pdf(p_brand text, p_month text)
returns bytea language sql stable security definer set search_path to 'public' as $$
  select r.shared_pdf
  from client_reports r
  join clients c on c.id = r.client_id
  where c.slug = p_brand and r.month = p_month
    and r.shared_at is not null
    and auth_can_read_client_slug(p_brand);
$$;

create or replace function admin_report_months(p_brand text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'month', r.month, 'report', r.report, 'has_pdf', (r.pdf is not null),
             'generated_at', r.generated_at, 'generated_by', r.generated_by,
             'shared_at', r.shared_at, 'shared_by', r.shared_by,
             'has_shared', (r.shared_report is not null))
           order by r.month desc), '[]'::jsonb)
  from client_reports r
  join clients c on c.id = r.client_id
  where c.slug = p_brand and auth_is_admin();
$$;

create or replace function admin_report_pdf(p_brand text, p_month text)
returns bytea language sql stable security definer set search_path to 'public' as $$
  select r.pdf
  from client_reports r
  join clients c on c.id = r.client_id
  where c.slug = p_brand and r.month = p_month and auth_is_admin();
$$;

revoke all on function report_months(text), report_pdf(text, text),
  admin_report_months(text), admin_report_pdf(text, text) from public, anon;
grant execute on function report_months(text), report_pdf(text, text),
  admin_report_months(text), admin_report_pdf(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- client_analyses: monthly ANALYSIS reports (six-tool GEO + SEO visibility). Shaped like
-- client_reports (WORKING half + reserved SHARED snapshot) so the generate/list/delete/pdf plumbing
-- clones cleanly and a future share-to-client needs no migration. RLS enabled and all authenticated
-- grants revoked: the local engine reads it over the owner connection, and no hosted (PostgREST)
-- read exists yet, so no SECURITY DEFINER functions are defined (they would be dead SQL). Add them
-- exactly like report_months/admin_report_months above if a hosted read is ever needed. See
-- 027_client_analyses.sql for the full account.
-- ---------------------------------------------------------------------------
create table if not exists client_analyses (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  month          text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  analysis       jsonb,
  pdf            bytea,
  generated_at   timestamptz,
  generated_by   text,
  shared_analysis jsonb,
  shared_pdf      bytea,
  shared_at       timestamptz,
  shared_by       text,
  created_at     timestamptz not null default now(),
  unique (client_id, month)
);
create index if not exists client_analyses_client on client_analyses (client_id);
alter table client_analyses enable row level security;
revoke all on client_analyses from authenticated, anon;

commit;

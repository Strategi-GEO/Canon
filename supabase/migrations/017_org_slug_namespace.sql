-- 017_org_slug_namespace.sql
-- Three things the DATABASE now enforces that until this file only the application asked for
-- politely, plus one comment that stops a column claiming a guarantee nothing checks.
--
--   1. The org/brand slug collision, which server/clients.py guards and a psql session walks
--      straight past.
--   2. A per-brand bound on the resources bucket, because 015's file_size_limit caps ONE
--      object and a write seat can PUT an unbounded number of distinct ones.
--   3. client_resources.sha256 stated for what it is, a client-asserted content address
--      rather than an integrity guarantee, because nothing in the portal path re-reads the
--      bytes to check it.
--
-- SAFE ON A LIVE DB, with ONE condition named here rather than discovered on the way. It adds
-- constraint triggers, two limit functions, one trigger on storage.objects, and two column
-- comments. It alters no column, drops nothing, and rewrites no row. The condition is that the
-- constraint triggers below are NOT validated against existing rows: Postgres checks a trigger
-- only on rows written after it exists, so a collision already sitting in the record survives
-- this migration untouched. That is deliberate and it is the same position server/clients.py
-- took in its `synthesised_org_collides` docstring: a row written before the rule existed was
-- legal when it was written, and the read-time guard in server/cms/routes.py is what catches it
-- at the last moment before a key is resolved. Query for pre-existing collisions before you
-- assume there are none:
--
--   select c.slug from clients c join orgs o on o.slug = c.slug
--    where c.org_id is null and c.deleted_at is null;
--
-- Idempotent: create or replace on every function, drop-then-create on every trigger, and
-- `comment on` is last-writer-wins. Keep in sync with schema.sql, the authority for fresh
-- builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/017_org_slug_namespace.sql
--
-- NOTE ON OWNERSHIP: the quota trigger in part 2 is created ON storage.objects, which is owned
-- by supabase_storage_admin. The same caveat 015's header states applies unchanged: on Supabase
-- the `postgres` role this script connects as is a member of that role, and if this migration
-- fails with "must be owner of table objects", run it from the Supabase SQL editor. Do not work
-- around it by dropping part 2, because part 2 is the only bound on the bucket that exists.

begin;

-- ===========================================================================
-- PART 1: no self-org brand may share a slug with an orgs row
-- ===========================================================================
-- THE INVARIANT, in one sentence: NO ROW IN clients WITH org_id NULL AND deleted_at NULL MAY
-- HAVE A slug EQUAL TO ANY orgs.slug.
--
-- WHY IT MATTERS is stated at length in server/clients.py above `_self_org_clients`, and it is
-- not repeated here beyond the shape of it: a brand with org_id null synthesises its own slug
-- as its org, server/cms/routes.py turns that synthesised slug into
-- STRATEGI_CMS_WRITE_KEY_<ORG>, and the CMS derives the destination tenant FROM THE KEY. So a
-- brand `acme` with no org of its own is handed the real org `acme`'s key, one client's blog
-- lands in another client's CMS, and neither side of the request can notice, because the
-- payload is forbidden from carrying an org_id that would contradict the key.
--
-- WHY THE DATABASE AND NOT ONLY THE APPLICATION. server/clients.py already refuses both
-- directions of this write. Those guards are real and they stay. What they cannot cover is
-- every write that does not go through them: a psql session, a repair script, a restore, a
-- future endpoint whose author has not read that module. orgs.slug and clients.slug are `not
-- null unique` in SEPARATE tables and NOTHING in the schema compares the two namespaces, so
-- until this file the record was perfectly happy to hold the collision. A rule that lives only
-- in one Python module is a rule the next writer does not know about.
--
-- WHY TRIGGERS AND NOT A UNIQUE INDEX. There is no index that expresses this. A unique index
-- spans one table, and the two slugs live in two, so the only index-shaped answer is a
-- materialised union of both namespaces, which is a third copy of the truth that the two
-- originals get to disagree with. It would also be WRONG, because the invariant is not "these
-- two namespaces are disjoint". THE LEGAL FLAGSHIP CASE HAS TO KEEP WORKING: a brand `acme`
-- whose org_id points at the org `acme` is the ordinary, common thing an operator does when
-- they name an org after its flagship brand, and it is SAFE precisely because the org_id is the
-- operator's own statement that these are one tenant, so the key that resolves is that org's
-- own key and the synthesis never happens. A unique index across the union forbids exactly that
-- case. The predicate is conditional on org_id, so the check has to be, too.
--
-- WHY CONSTRAINT TRIGGERS, DEFERRED, AND NOT PLAIN ONES. `_upsert_org` inserts the orgs row and
-- THEN points the client's org_id at it, inside one transaction. Checked immediately, the orgs
-- insert is evaluated while the client still reads org_id null, so moving an existing brand
-- into an org named after it would fail at the halfway point of a transaction whose final state
-- is legal. A DEFERRABLE INITIALLY DEFERRED constraint trigger fires at COMMIT, so it judges
-- the state the transaction actually leaves behind and never an intermediate one. That is also
-- what lets the two triggers below coexist without ordering rules: either write order reaches
-- the same commit-time answer.
--
-- WHY TWO TRIGGERS AND NOT ONE. One invariant, two tables that can break it, and a trigger sees
-- only its own. They mirror `_refuse_org_slug_collision` and `_refuse_self_org_collision`
-- exactly, including the split in their messages, because a caller told only "collision" cannot
-- tell whether to rename the org or to give the brand one.

-- ---------------------------------------------------------------------------
-- THE SOFT-DELETE QUESTION, DECIDED AND ARGUED
-- ---------------------------------------------------------------------------
-- server/clients.py filters `deleted_at is null` on BOTH sides of this guard, so a soft-deleted
-- self-org brand does not block an org from taking its slug. A reviewer found that, correctly,
-- and asked whether these triggers should instead include deleted rows. They should NOT, and
-- the undelete hole the reviewer named is closed a different way. The reasoning, because the
-- answer is genuinely not obvious:
--
-- INCLUDING DELETED ROWS MAKES A LEGAL OPERATION ILLEGAL. Soft delete exists so a brand's
-- record survives its removal from the product. A deleted brand cannot publish: every reader in
-- this schema and in server/db.py filters deleted_at, so no run starts, no CMS key is resolved,
-- and no blog goes anywhere. Its slug is therefore dead weight in the org namespace, and
-- refusing to let an org reuse it means an operator who deletes the brand `acme` can never
-- afterwards create an org called `acme`, forever, for a row nobody can see. That refusal would
-- also arrive from a trigger the application has no sentence for, so the operator would read a
-- database error instead of the careful message `_refuse_org_slug_collision` writes.
--
-- THE EXPOSURE IS REAL BUT IT IS NOT AT DELETE TIME, IT IS AT UNDELETE TIME. While the row is
-- deleted the collision is inert. It becomes live the moment someone sets deleted_at back to
-- null, and at that instant the record holds exactly the state this invariant forbids, written
-- by nobody the guards were watching.
--
-- SO THE TRIGGER FIRES ON deleted_at TOO. The clients trigger below lists deleted_at in its
-- UPDATE OF columns, which is the whole of the fix: the invariant stays scoped to LIVE rows, so
-- it agrees with server/clients.py sentence for sentence and forbids nothing the application
-- allows, and a row that BECOMES live is re-checked at the moment it becomes live. An undelete
-- that would recreate the collision is refused; an undelete that would not is untouched.
--
-- THAT REFUSAL IS THE ONE PLACE THIS TRIGGER IS THE ONLY GUARD, and it is worth being precise
-- about why it is worth a raw database error. server/clients.py says in its own words that
-- "reviving a dead slug is a decision for a human with database access, not for an onboarding
-- form", so there IS no undelete endpoint: the only way to run one is by hand, by a person who
-- can read the message this trigger raises. A hand-written UPDATE is the exact caller a database
-- guard is for, and the alternative is that the same person silently reinstates a cross-tenant
-- CMS collision with a one-line statement.
--
-- THE TRIGGER AND server/clients.py THEREFORE AGREE, with no silent difference to declare. Both
-- scope the invariant to live rows on both sides. The trigger checks strictly more WRITES,
-- which is its whole job, and it never calls illegal a state the application would have called
-- legal.

create or replace function refuse_org_slug_collision() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_brand text;
begin
  -- Fires on orgs. The offending party is any LIVE brand carrying this slug with no org of its
  -- own, which is exactly the set that would resolve this org's CMS write key by synthesis. A
  -- brand that HAS an org is not in the set however its slug reads, which is the flagship case
  -- the header defends.
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
  -- Fires on clients. Only a LIVE brand with NO org can break the invariant, so a brand that
  -- carries an org_id and a brand that is soft-deleted both leave immediately. That early exit
  -- is what makes listing deleted_at in the trigger's UPDATE OF columns cheap: an undelete of an
  -- org-bearing or non-colliding brand reaches this line and returns.
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

-- UPDATE OF is a fire list and not a change test: Postgres queues the check when the column
-- appears in the SET list, whether or not the value moved. That is the behaviour wanted here,
-- because the cost of a redundant check is one indexed lookup and the cost of a missed one is
-- the collision.
--
-- slug is documented immutable (PATCH /api/clients/{slug} cannot change it) and is listed
-- anyway, because "immutable" is a statement about the application and this file exists for the
-- writers that are not the application.
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

-- ===========================================================================
-- PART 2: a per-brand bound on the resources bucket
-- ===========================================================================
-- WHAT 015 ACTUALLY CAPPED, AND WHAT IT DID NOT. file_size_limit is checked by storage-api
-- against the bytes of ONE object during ONE upload. It is the right control and it is
-- unroutable, and it says nothing whatever about how many objects there are. A member holding a
-- write seat satisfies resources_insert_scoped for every key under their own slug, and the keys
-- are content-addressed, so distinct bytes are distinct keys with no collision to stop them. The
-- member can PUT 25 MiB at a time, forever, and never call portal_resource_add once.
--
-- WHY UNINDEXED OBJECTS ARE THE WHOLE PROBLEM. Everything in this product that reads resources
-- reads the INDEX: client_resources drives the portal list, sync.materialize_client, the
-- signed-URL route, and the admin console. An object nobody indexed appears in none of them. It
-- is not merely unbilled and unnoticed, it is UNRECLAIMABLE by any path this product offers,
-- because portal_resource_remove is keyed on a client_resources row and there is no row. It
-- would take a person with the secret key listing the bucket by hand.
--
-- WHY THE BOUND IS ON storage.objects AND NOT ON client_resources. An index-side count would be
-- easy and would bound the wrong thing: the indexed corpus is the part the product can already
-- see and already delete. Every indexed resource has a storage object, so a bound on the bucket
-- bounds both, and it is the only one of the two that reaches the objects nobody declared.

-- ---------------------------------------------------------------------------
-- THE TWO NUMBERS. CHANGE THEM HERE. THE OPERATOR DID NOT NAME THEM.
-- ---------------------------------------------------------------------------
-- These are defaults chosen against the measured corpus, not requirements handed down. The live
-- corpus is 5 files and about 12.8 MB across two brands, the largest single file being a 12.8 MB
-- brochure. So the caps below sit roughly fifty times above the largest real corpus by object
-- count and eighty times above it by bytes, which is far enough that no client doing the thing
-- the product is for will ever meet one, and near enough that the abuse case stops being
-- unbounded. If either number is wrong for this business, it is one literal in one function and
-- every enforcement point reads it.
--
-- The two are not redundant, they fail in different directions. The BYTE cap is the number
-- anyone actually cares about and it is what binds in practice. The OBJECT cap is what still
-- holds when the byte sum cannot be computed, which the trigger explains below, and it is what
-- bounds a flood of tiny objects that costs little storage and still makes the bucket
-- unlistable.
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
  -- Scoped to this bucket FIRST, for the reason 015 gives about its policies: a rule written for
  -- this feature must not quietly govern every bucket this project adds later.
  if new.bucket_id is distinct from 'resources' then
    return new;
  end if;

  v_prefix := (storage.foldername(new.name))[1];
  if v_prefix is null then
    -- A key with no folder segment belongs to no brand, so no per-brand bound applies to it.
    -- resources_insert_scoped already refuses such a key for every `authenticated` caller, so
    -- the only writer that reaches this line is the secret key, which is ours.
    return new;
  end if;

  -- THE COUNT AND THE SUM COME FROM THE ROWS ALREADY PRESENT, so the object being inserted is
  -- not in either figure. That makes the effective ceiling one object and one file_size_limit
  -- above the stated caps, which is deliberate rather than sloppy: a BEFORE INSERT trigger on
  -- storage.objects sees a row whose metadata storage-api has not written yet, so NEW carries
  -- no trustworthy size, and inventing one would be exactly the client-asserted number this
  -- file's part 3 refuses to treat as fact. A 25 MiB overshoot on a 1 GiB cap is noise; a
  -- quota computed from a number the caller supplied is not a quota.
  --
  -- `o.name <> new.name` matters for the same reason: storage-api can re-insert a key that is
  -- already present, and counting the row twice would refuse a re-upload of something the brand
  -- already owns.
  --
  -- coalesce ON THE ELEMENT, not only on the sum: metadata is written after the upload lands, so
  -- an object still in flight contributes null and would otherwise null out the whole sum and
  -- disable the byte cap for as long as any upload is open. Undercounting one object is the
  -- honest failure here, and the object cap is what still binds while it happens.
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
      -- THIS QUOTA MUST NEVER TAKE DOWN AN UPLOAD FOR A REASON THAT IS NOT A QUOTA. Whether this
      -- function can read storage.objects at all depends on whether its OWNER bypasses RLS on a
      -- table owned by supabase_storage_admin, the same uncertainty 016 names twice and for the
      -- same reason: on Supabase the migrating role is postgres and it does, but this file cannot
      -- verify that without running. If the read raises, the failure direction that matters is the
      -- bad one, every upload refused and the feature dead, so the read degrades to admitting the
      -- object, which is exactly the behaviour before this file existed. The warning carries the
      -- SQLSTATE, because a silent degradation is a control that is not there and nobody knows it.
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

-- A PLAIN TRIGGER, NOT A CONSTRAINT TRIGGER, and BEFORE rather than AFTER. Part 1's invariant is
-- about the state a transaction leaves behind, so it is checked at commit. This is a resource
-- bound on one statement, so it is checked before the statement does anything, which is also the
-- only point at which refusing it is cheap.
--
-- IT GOVERNS THE SECRET KEY TOO, and that is correct rather than an oversight. RLS bypass is not
-- trigger bypass, so migrate.py's own bulk push is bounded by the same numbers. A quota the
-- operator's tooling is exempt from is a quota that gets discovered by an operator's mistake.
drop trigger if exists resources_prefix_quota on storage.objects;
create trigger resources_prefix_quota
  before insert on storage.objects
  for each row execute function enforce_resources_prefix_quota();

-- ===========================================================================
-- PART 3: sha256 says what it is
-- ===========================================================================
-- THE COLUMN WAS AN INTEGRITY CLAIM NOTHING CHECKED. The digest is computed in the BROWSER, and
-- from that point it is only shape-checked: SHA256_RE in the upload-url route and the identical
-- regex in portal_resource_add both prove it is 64 hex characters and nothing else. No code in
-- the portal path ever re-reads the bytes and hashes them, so a reader who saw a sha256 column
-- and concluded the stored content was pinned would be wrong, and would be wrong in the
-- direction that matters: the content behind an indexed resource can be replaced without the row
-- changing, and every agent that reads the corpus would read the new bytes under the old row.
--
-- WHY NOT RE-HASH SERVER-SIDE. It is the complete answer and it is the wrong trade here.
-- Re-hashing means pulling every object's bytes back out of Storage, which is real transfer and
-- real time on a 12.8 MB brochure, and it buys protection against a threat model that is a
-- logged-in member of the SAME tenant swapping one of their OWN documents. That member can
-- already delete the resource and upload a different one through the front door. Spending a full
-- read of the corpus to detect a thing the same person may simply do is not a good trade.
--
-- WHY NOT VERIFY LAZILY ON DOWNLOAD. Same cost, moved to the moment a client is waiting, and it
-- turns a corrupted or swapped object into a failed download rather than into a report. It also
-- lives in the download route, which is not this file.
--
-- WHAT IS DONE INSTEAD, and it is two cheap things rather than one expensive one.
--
--   1. THE SIZE IS CROSS-CHECKED against what Storage recorded, in portal_resource_add. That
--      change lives in 016 and in schema.sql, next to the function it guards, because a check
--      belongs in the body it runs in. It closes the one gap 015's own comment names out loud,
--      a client uploading at the cap and then indexing it as 1024 bytes, and it is honest about
--      its limit: a size that matches proves the row describes the object it points at, and
--      proves nothing at all about the digest.
--
--   2. THE COLUMN SAYS WHAT IT IS, here, in the database, where anyone reading the schema finds
--      it without reading this migration. A comment is not a control and is not offered as one.
--      It is the difference between a system that does not verify the digest and a system that
--      does not verify the digest while implying it does, and only the second one misleads the
--      next person who has to trust this column.
--
-- ONE PATH DOES VERIFY, AND IT IS NAMED SO THE COMMENT IS NOT OVERBROAD. supabase/migrate.py's
-- upload_resources reads every object back after writing it and dies if the sha256 of the bytes
-- that landed differs from the source file. The operator's bulk push is therefore genuinely
-- verified end to end. The portal path is the one that is not, and it is the one that takes
-- input from someone other than us.
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

commit;

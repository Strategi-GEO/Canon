-- 015_resource_storage.sql
-- Storage RLS for the Resources bucket, so the HOSTED portal can upload and download
-- resource bytes with the signed-in user's own JWT instead of the secret key.
--
-- WHY THE BROWSER MUST TALK TO STORAGE DIRECTLY, AND WHY THIS FILE IS THEREFORE FORCED.
-- Vercel caps a serverless request body at 4.5 MB on every plan, while server/clients.py
-- sets MAX_RESOURCE_BYTES to 25 MiB and the live corpus already holds a 12.8 MB brochure.
-- An upload proxied through a Route Handler is not slow, it is IMPOSSIBLE: the platform
-- rejects the request before any of our code runs. So the file goes browser -> Storage,
-- authenticated by the user's JWT, which means storage.objects RLS is the ONLY thing
-- standing between one client's private documents and another's. There were no storage
-- policies anywhere in this repo before this file; the bucket was private and reachable by
-- the secret key alone, which the hosted app deliberately does not hold.
--
-- WHAT THE KEYS LOOK LIKE. db.resource_add stores bytes at `<client_slug>/<sha256>` inside
-- bucket `resources`, and client_resources.object_path records the same key with the bucket
-- name prefixed. A policy on storage.objects sees only the key string, so the scope key here
-- is the SLUG in the first path segment, never the client uuid the rest of the schema uses.
-- That is why this file adds slug-keyed predicates rather than reusing auth_can_read_client.
--
-- SAFE ON A LIVE DB: purely additive. It creates two functions and three policies, sets one
-- column on the bucket's own row, and grants nothing to anon. The engine and the sync path
-- connect with the secret key, which bypasses RLS entirely, so nothing about current behavior
-- changes for them.
--
-- Idempotent: create or replace on the functions, drop-then-create on the policies, and a
-- plain update for the bucket's size cap, which lands on the same value however often it runs.
-- Keep in sync with schema.sql, the authority for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/015_resource_storage.sql
--
-- NOTE ON OWNERSHIP: storage.objects and storage.buckets are owned by
-- supabase_storage_admin. On Supabase the `postgres` role this script connects as is a
-- member of that role, which is how the dashboard's own policy editor works. If this
-- migration fails with "must be owner of table objects", run it from the Supabase SQL
-- editor instead; do not work around it by weakening the bucket to public. The
-- file_size_limit update below writes to storage.buckets and falls under this same caveat,
-- with one difference worth knowing before you read its output: it does not fail loudly if the
-- role cannot reach the table, it updates nothing and says so in a notice, for the fresh-build
-- reason its own comment gives.

begin;

-- ---------------------------------------------------------------------------
-- Preflight: the storage schema has to exist before policies can reference it
-- ---------------------------------------------------------------------------
-- A plain Postgres without supabase/storage-api has no storage.objects, and the error
-- Postgres raises for that ("relation does not exist") reads like a typo rather than like
-- a missing component. Fail with the reason, exactly as 001 does for PostgreSQL 15.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise exception
      'geo-factory storage policies need the Supabase storage schema; storage.objects '
      'was not found. This migration targets a Supabase database, not bare Postgres.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Slug-keyed membership predicates
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for the same reason auth_can_read_client is: org_membership is a
-- security_invoker view over clients, and clients carries its own RLS read policy, so a
-- plain invoker function would see the view already filtered and the predicate would answer
-- a question about what the caller can SELECT rather than about what they are a member of.
-- Running as the owner reads the membership tables whole. search_path is pinned to public
-- exactly as its three siblings pin it, so a caller cannot shadow org_membership or
-- org_members with a temp object of the same name and vote themselves into a brand.

-- The read predicate. Admin-inclusive, mirroring auth_can_read_client: an admin sees every
-- brand, a client sees only brands whose derived org slug they hold a membership row for.
-- It answers false for a slug that does not exist, for a soft-deleted brand and for the `_`
-- fixture brands, because org_membership already excludes all three. Losing browser reach
-- to a deleted brand's bytes is correct: the secret-key path still reads them for restore.
create or replace function auth_can_read_client_slug(cslug text) returns boolean
  language sql stable security definer set search_path = public as $$
  select auth_is_admin()
      or exists (
        select 1 from org_membership m
        where m.client_slug = cslug
          and m.org_slug in (select auth_org_slugs())
      )
$$;

-- The write predicate, and it is deliberately NOT the read predicate with a different name.
-- Two differences, both load-bearing:
--   * NO admin bypass. The product rule is that ONLY clients upload and manage resources,
--     so an admin who is not a member of the brand's org gets read and nothing more. An
--     admin who IS such a member writes as that member, which is the same door, not a
--     second one.
--   * The writing ROLE is required. org_members.role is one of admin/viewer/commenter and
--     the portal's existing write doors (portal_suggest_change, portal_approve_blog) all
--     gate on role in ('admin','commenter'). A viewer is a read seat; letting one add or
--     delete a 25 MB document would make it the only write in the portal a viewer can do.
create or replace function auth_can_write_client_slug(cslug text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from org_membership m
    join org_members om on om.org_slug = m.org_slug
    where m.client_slug = cslug
      and om.user_id = auth.uid()
      and om.role in ('admin', 'commenter')
  )
$$;

revoke all on function auth_can_read_client_slug(text), auth_can_write_client_slug(text)
  from anon;
grant execute on function auth_can_read_client_slug(text)  to authenticated;
grant execute on function auth_can_write_client_slug(text) to authenticated;

-- ---------------------------------------------------------------------------
-- storage.buckets: the caller must be able to SEE the bucket to use it
-- ---------------------------------------------------------------------------
-- storage-api resolves the bucket row on the CALLER's connection for several object
-- operations, so with RLS on storage.buckets and no policy the upload fails with a bucket
-- not found that looks nothing like a permissions problem. This policy exposes ONE row and
-- exposes only that the bucket named `resources` exists and is private, which every client
-- of this app already knows from the URL it posts to. It grants no reach over any OBJECT:
-- object access is decided entirely by the three policies below.
drop policy if exists resources_bucket_visible on storage.buckets;
create policy resources_bucket_visible on storage.buckets for select to authenticated
  using (id = 'resources');

-- ---------------------------------------------------------------------------
-- storage.buckets: the 25 MiB cap, put where Storage itself enforces it
-- ---------------------------------------------------------------------------
-- THIS FILE IS WHAT MAKES THIS LINE NECESSARY, so it belongs in this file. Until now the
-- bucket was reachable by the secret key alone, every byte entering it passed through
-- server/clients.py, and MAX_RESOURCE_BYTES there was the entire enforcement story. The insert
-- policy above ends that arrangement: the browser PUTs to Storage directly, because Vercel's
-- 4.5 MB body cap makes proxying a 25 MiB file impossible, and from that moment no server of
-- ours ever weighs the bytes. What remains is portal_resource_add's size check, which runs
-- AFTER the upload has landed and reads a number the BROWSER supplied, so it is not a cap on
-- the upload at all. A client can PUT at the project default, which is 50 MB on a new project
-- and twice the limit we publish, then simply never call the index RPC, or call it declaring
-- 1024 bytes. An object nobody indexed is invisible to every query this app makes.
--
-- file_size_limit is checked by storage-api during the upload, before any SQL of ours runs and
-- against the bytes themselves rather than against a claim about them. That makes it the only
-- statement of this limit a caller cannot route around, which is why the number belongs here
-- and not only in the three places that describe it after the fact. 26214400 is
-- MAX_RESOURCE_BYTES in server/clients.py and the bound on the client_resources.size_bytes
-- check constraint; the three move together or the smallest one silently becomes the real cap.
--
-- NO allowed_mime_types, DELIBERATELY, and the asymmetry with the size cap is the reasoning.
-- A resource corpus is a client's knowledge base and is heterogeneous by design: PDFs,
-- markdown, CSVs, plain text and images all belong in one, and the set is open because the
-- next client arrives with a format no list written today predicted. An allowlist would
-- therefore reject documents a client is entitled to upload, and the failure would look like a
-- broken portal rather than a policy. It would also buy little: a MIME type is a header the
-- caller sends, not a property of the bytes, so anyone motivated enough to defeat one only has
-- to relabel the file. Size is the opposite, being the one property of an upload that cannot be
-- misdeclared to Storage, so the size cap is the load-bearing control and it carries this alone.
--
-- WHAT THIS LINE DOES NOT CAP, NAMED HERE SO IT IS NOT MISTAKEN FOR A FULL ANSWER.
-- file_size_limit governs ONE object in ONE upload and says nothing about how many objects
-- there are, so a write seat can PUT distinct 25 MiB objects under its own prefix without end.
-- Migration 017 adds the per-brand bound that closes that, a trigger on storage.objects reading
-- resource_prefix_max_objects() and resource_prefix_max_bytes(). The two paragraphs above also
-- name the second half of the move, indexing an upload as 1024 bytes, and 016's portal_resource_add
-- now cross-checks the declared size against the size Storage recorded wherever it can see the
-- object row, so that half is answered where the claim is made rather than here.
--
-- An UPDATE and not an INSERT, because supabase/migrate.py owns creating this bucket and a
-- second creator here would race it. Where the row is absent this updates nothing, which is
-- correct rather than a failure: on a fresh project schema.sql runs BEFORE upload_resources
-- creates the bucket, so raising here would break every fresh build, and migrate.py's create
-- payload carries this same number so such a project is born with the cap already set. The
-- notice exists because the other way to reach zero rows is a live database where the cap is
-- now NOT set, and that must never pass silently.
do $$
declare
  n_buckets int;
begin
  update storage.buckets set file_size_limit = 26214400 where id = 'resources';
  get diagnostics n_buckets = row_count;
  if n_buckets = 0 then
    raise notice
      'no file_size_limit was set: no row of storage.buckets matched id = ''resources''. '
      'Either the bucket does not exist yet, which is expected on a fresh build because '
      'supabase/migrate.py creates it carrying the same 26214400 limit, or this role cannot '
      'reach storage.buckets, which the NOTE ON OWNERSHIP in this file''s header covers. On a '
      'live database the second case means the 25 MiB cap is UNSET and a client can upload at '
      'the project default; re-run this statement from the Supabase SQL editor.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- storage.objects: read, create, remove. No update, and that is a decision.
-- ---------------------------------------------------------------------------
-- Every policy below is scoped to bucket_id = 'resources' FIRST. Without that predicate a
-- policy written for this feature would also govern every other bucket this project ever
-- adds, which is how a storage rule quietly outgrows the thing it was written for.
--
-- (storage.foldername(name))[1] is the first path segment of the key, which for this bucket
-- is the client slug. The predicate can therefore be satisfied ONLY by a slug the caller
-- holds a membership row for: there is no wildcard, no prefix match and no LIKE, so
-- `acme/<sha>` and `acme-holdings/<sha>` are different values and neither implies the other.
-- A caller with no membership at all satisfies nothing and sees nothing.

-- SELECT: anyone who may READ the brand, which is both admins and client members. Downloads
-- are the one resource operation an admin needs, because the admin console lists a brand's
-- knowledge base. DENIES: every object under a slug the caller has no membership for, every
-- object in any other bucket, and everything at all to anon.
drop policy if exists resources_read_scoped on storage.objects;
create policy resources_read_scoped on storage.objects for select to authenticated
  using (
    bucket_id = 'resources'
    and auth_can_read_client_slug((storage.foldername(name))[1])
  );

-- INSERT: client members with the writing role, uploading under their OWN brand's slug.
-- DENIES: an upload under another brand's slug, an upload by a viewer, an upload by an admin
-- who is not a member of that org, and an upload to any other bucket.
--
-- The depth check is the second half of this policy and it is not decoration. Storage keys
-- are literal strings and are NOT validated against the client_slug domain, so `mybrand/../
-- otherbrand/x` is a legal key whose first segment is still `mybrand`. Such an object could
-- never be READ as another brand's, since the read policy reads the same first segment, but
-- it would litter a namespace this app treats as flat. Every legitimate key is exactly
-- `<client_slug>/<sha256>`, one folder deep, so requiring that costs nothing and removes the
-- whole question.
drop policy if exists resources_insert_scoped on storage.objects;
create policy resources_insert_scoped on storage.objects for insert to authenticated
  with check (
    bucket_id = 'resources'
    and array_length(storage.foldername(name), 1) = 1
    and auth_can_write_client_slug((storage.foldername(name))[1])
  );

-- DELETE: the same client members, removing their own brand's resources. The portal's delete
-- is how a client manages the knowledge base an agent reads, so it belongs to the same seats
-- that upload. DENIES: deleting another brand's object, deleting as a viewer, and deleting as
-- a non-member admin, which means no admin can silently drop a document from a brand's fact
-- base without holding a seat in it.
drop policy if exists resources_delete_scoped on storage.objects;
create policy resources_delete_scoped on storage.objects for delete to authenticated
  using (
    bucket_id = 'resources'
    and auth_can_write_client_slug((storage.foldername(name))[1])
  );

-- NO UPDATE POLICY, DELIBERATELY. On storage.objects an UPDATE governs both overwriting an
-- existing key (the x-upsert header) and moving one to a new key. Neither is an operation
-- this bucket has: objects are content-addressed at `<slug>/<sha256>`, so different bytes are
-- a different key by construction and there is nothing an overwrite could ever legitimately
-- change. The product rule points the same way from the other end: a duplicate filename WARNS
-- AND IS REJECTED, never silently overwritten, and an UPDATE policy would hand the browser
-- exactly the overwrite the rule forbids. Absent a policy the operation is denied by RLS
-- default, so the rule is enforced by the database rather than by the upload client
-- remembering not to send an upsert. Replacing a resource is delete then insert, two acts the
-- operator can see, and it stays that way.

commit;

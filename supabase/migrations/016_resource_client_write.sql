-- 016_resource_client_write.sql
-- The index half of client resource management: two SECURITY DEFINER functions, one that
-- records a client_resources row for bytes the browser has already put into Storage, and one
-- that removes a resource, index row and stored object together, in a single call.
--
-- WHY A FUNCTION AND NOT AN INSERT GRANT. `authenticated` holds SELECT and nothing else on
-- every table in this schema (001, folded into schema.sql), and lib/server/postgrest.ts states
-- the same rule from the app side: reads plus RPCs, no other write path exists. Granting INSERT
-- on client_resources would be the first table-level write privilege a browser JWT has ever
-- held here, and it would carry every column with it: a client could insert a row naming
-- another brand's client_id, or point object_path at an object they do not own, because RLS
-- filters ROWS and cannot stop a caller from writing a row that satisfies the filter. So the
-- write goes through a function that derives every scoping value itself.
--
-- WHY IT IS A portal_ FUNCTION AND NOT AN admin_ ONE. The product rule is that ONLY clients
-- upload and manage resources. 015 already encoded that in auth_can_write_client_slug, which
-- deliberately has NO admin bypass, and this function reuses that predicate rather than writing
-- a second answer to the same question. An admin who holds a seat in the org writes as that
-- member, which is the same door and not a second one.
--
-- WHY IT TAKES A SLUG AND A SHA AND NOT AN object_path. 009 states the rule this obeys:
-- NEVER ACCEPT AN ID. A caller-supplied object_path is worse than an id, because it is the
-- pointer to the bytes themselves: `resources/<other-brand>/<sha>` would index another brand's
-- private document into this brand's knowledge base, and the row would pass every check that
-- looked at client_id. The path is therefore BUILT here from the brand this call is authorised
-- for, so the only object a caller can index is one under their own slug, which is the same set
-- 015's resources_insert_scoped let them upload.
--
-- SAFE ON A LIVE DB: purely additive. It creates two functions and grants both to
-- `authenticated`. It alters no table, adds no constraint, and changes nothing for the engine,
-- which connects with the secret key and never calls either of them.
--
-- Idempotent: create or replace. Keep in sync with schema.sql, the authority for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/016_resource_client_write.sql

begin;

-- ---------------------------------------------------------------------------
-- portal_resource_add
-- ---------------------------------------------------------------------------
-- Mirrors db.resource_add's contract, including its refusal: a filename already in use is
-- REFUSED and never upserted. That function's docstring gives the reason and names this exact
-- code path as the one it was written for: "Soon the only uploader is the CLIENT, through a
-- hosted path with no operator watching the request, which is why the refusal is being put in
-- now rather than after that path exists: an overwrite nobody sees is worse than an overwrite
-- an admin at least performed deliberately." This is that path, so the refusal is a hard rule
-- here rather than a convention.
--
-- WHERE IT IS STRICTER THAN THE ENGINE. db.resource_add does a read-then-write and admits, in
-- its own comment, that two uploads of one filename racing each other both pass the check and
-- the second surfaces as a 500 rather than a 409. Inside a single plpgsql transaction the
-- exception handler below closes that: a unique violation is caught and re-raised as the SAME
-- catchable code the pre-check raises, so a race and a plain duplicate are one answer to the
-- caller. The pre-check survives anyway, because it can name the conflicting row while the
-- constraint can only name the constraint.
--
-- Every refusal leaves as 'PORTAL:<CODE>:<detail>', the protocol rpc() parses and
-- adminRpcError maps. EXISTS is already 409 in that map, which is what the duplicate-filename
-- rule needs; DUPLICATEBYTES is new and must be added there to land as a 409 rather than a
-- bare 400.
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

  -- AUTHORISE BEFORE EXISTING, the ordering 003 established for portal_submit_answers and 009
  -- restated: a refusal that differs by scope is an enumeration oracle. auth_can_write_client_slug
  -- answers false for a slug that does not exist, for a soft-deleted brand, for a brand the
  -- caller has no membership in, and for a viewer seat, and all four get this one sentence.
  if not auth_can_write_client_slug(p_client_slug) then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  select c.id into v_cid from clients c
   where c.slug = p_client_slug and c.deleted_at is null;
  if v_cid is null then
    -- Only reachable if the brand was deleted between the predicate and this select. Same
    -- sentence, so the two paths stay indistinguishable.
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  -- Shape checks BEFORE the insert, so a malformed argument is a sentence rather than a check
  -- constraint arriving at the browser as a 500. Each mirrors a constraint on the table.
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
  -- MAX_RESOURCE_BYTES in server/clients.py. The same limit, stated where a browser cannot
  -- route around it: the upload went straight to Storage, so no server of ours measured it.
  if p_size_bytes > 26214400 then
    raise exception 'PORTAL:TOOLARGE:that file is over 25 MiB, which is the resource limit';
  end if;

  -- The key db.resource_add writes, rebuilt from values this call is authorised for. Never a
  -- parameter; see the header.
  v_path := 'resources/' || p_client_slug || '/' || p_sha256;

  -- REFUSAL ONE: the filename is taken. Named separately from the bytes case because the two
  -- have different fixes, and a caller told only "conflict" cannot tell which one they hit.
  select cr.name into v_other from client_resources cr
   where cr.client_id = v_cid and cr.name = p_name;
  if v_other is not null then
    raise exception 'PORTAL:EXISTS:a resource named % already exists for this brand; delete it first or upload under a different name', p_name;
  end if;

  -- REFUSAL TWO: these exact bytes are already indexed under a DIFFERENT filename.
  --
  -- client_resources.object_path carries a GLOBAL unique constraint and the path is
  -- content-addressed, so one brand uploading the same file twice under two names produces the
  -- same key and violates it. (Two different brands cannot collide: the slug is inside the
  -- path, so identical bytes under two brands are two different keys, and no cross-tenant
  -- refusal is possible here.)
  --
  -- The clean outcome is to REFUSE and say which file it already is, not to relax the
  -- constraint and not to let two rows share one object. Two rows sharing an object_path would
  -- be broken by the delete path, which is name-keyed and removes the Storage object: deleting
  -- either row would pull the bytes out from under the other, leaving an index entry whose
  -- download 404s and whose brand cannot tell why. The constraint is therefore load-bearing
  -- rather than incidental, and this refusal is the constraint stated in a sentence.
  select cr.name into v_other from client_resources cr where cr.object_path = v_path;
  if v_other is not null then
    raise exception 'PORTAL:DUPLICATEBYTES:this file is already stored for this brand as %; upload it once under the name you want', v_other;
  end if;

  -- REFUSAL THREE: the declared size disagrees with the size Storage recorded.
  --
  -- WHY THIS ONE EXISTS AT ALL. Every number in this call arrives from the browser. The upload
  -- went straight to Storage, because Vercel's 4.5 MB body cap makes proxying a 25 MiB file
  -- impossible, so no server of ours weighed the bytes, and the TOOLARGE check above is
  -- therefore a check on a CLAIM rather than on a file. 015's own comment names the resulting
  -- move out loud: PUT at the project default, then call this function declaring 1024 bytes.
  -- storage.objects.metadata carries the size storage-api measured itself, so comparing the two
  -- costs one indexed lookup and no bytes at all, and it turns the claim into something the
  -- record can contradict.
  --
  -- WHAT IT PROVES AND WHAT IT DOES NOT. A match proves this row describes the object it points
  -- at. It proves NOTHING about p_sha256, which is computed in the browser and re-read by
  -- nothing; migration 017 part 3 argues why re-hashing is the wrong spend and states the same
  -- limit as a comment on the column, so a reader finds it in the schema rather than here.
  --
  -- INVISIBLE IS A PASS, AND THAT IS THE WHOLE REASON THIS IS SAFE TO ADD. The note below this
  -- function has always refused to require that the object exist, because a definer function's
  -- reach into storage.objects depends on whether its owner bypasses RLS and this file cannot
  -- verify that without running: read the absence as a missing object and every upload is
  -- refused and the feature is dead. That reasoning is untouched. v_stored stays null when the
  -- row is missing AND when the row is merely unreachable, the two are indistinguishable, and
  -- both pass. Only a row this function can SEE, carrying a size that DISAGREES, is refused, so
  -- the check can never fail in the dead direction.
  --
  -- The nested block is a subtransaction, so a lookup that RAISES for a privilege reason leaves
  -- through the same door as one that returns nothing, rather than aborting the call. -1 marks a
  -- visible row whose metadata has no size yet, which happens while an upload is still in
  -- flight, and it passes for the same reason: it is an absence of evidence.
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
  -- The race the engine leaves open: two uploads within milliseconds of each other both pass
  -- the pre-checks and the index decides. Re-raised as the SAME code the pre-check would have
  -- used, so the caller never sees a raw constraint name and never sees a 500 for a conflict
  -- the product has a sentence for. CONSTRAINT_NAME distinguishes which unique fired; anything
  -- else keeps its own error rather than being swallowed into a wrong one.
  when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'client_resources_object_path_key' then
      raise exception 'PORTAL:DUPLICATEBYTES:this file is already stored for this brand under another name; upload it once under the name you want';
    end if;
    raise exception 'PORTAL:EXISTS:a resource named % already exists for this brand; delete it first or upload under a different name', p_name;
end
$$;

-- WHAT THIS DELIBERATELY DOES NOT CHECK: that the object actually exists in the bucket. A
-- definer function's reach into storage.objects depends on whether its owner bypasses RLS,
-- which this file cannot verify without running, and the failure direction is the bad one: if
-- the read comes back empty for a permissions reason rather than a missing-object reason, every
-- upload is refused and the feature is dead. An index row with no bytes behind it is a lesser
-- fault, scoped to the brand that created it, visible in their own list, and removable by the
-- same delete they already have.
--
-- REFUSAL THREE ABOVE DOES NOT WEAKEN THAT, and the distinction is worth being exact about
-- because the two look alike. It reads the same row and reaches the same uncertainty, and it
-- resolves it the other way round: an object it cannot see is ADMITTED, so the missing case and
-- the unreachable case both pass and neither can kill the feature. What it refuses is only a row
-- it CAN see whose recorded size contradicts the caller. Existence is still not required; a size
-- that is present and wrong is simply no longer accepted.
--
-- AND IT STILL DOES NOT CHECK THE DIGEST. p_sha256 is shape-checked and nothing more, here or
-- anywhere else in the portal path. Migration 017 part 3 argues why re-hashing every object is
-- the wrong spend against a threat model that is a member of the tenant swapping their own
-- document, and states the limit as a comment on client_resources.sha256 so a reader meets it in
-- the schema rather than in a migration.

-- Postgres grants EXECUTE to PUBLIC by default, so revoke first and then grant to
-- `authenticated` alone. Skipping the revoke would make this an unauthenticated write
-- primitive; the auth.uid() check inside would still refuse, but a door is not made safe by
-- what stands behind it.
revoke all on function portal_resource_add(text, text, text, bigint, text) from public, anon;
grant execute on function portal_resource_add(text, text, text, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- portal_resource_remove
-- ---------------------------------------------------------------------------
-- The delete 015 already authorised, and the reason a function has to mediate it rather than
-- the storage policy standing alone. resources_delete_scoped hands a client member a REAL
-- capability over the bytes: a browser holding that grant can delete the object out of the
-- bucket by itself, with no code of ours involved. It cannot delete the matching INDEX row by
-- any path that exists, because `authenticated` holds SELECT grants and nothing else on
-- client_resources (001, and lib/server/postgrest.ts states the same rule from the app side).
-- So what 015 grants is exactly half of a delete, and the half it grants is the destructive
-- one: the bytes are gone, the row is still listed, and the download route answers 502
-- "storage refused to sign" for a file the client believes they already removed.
--
-- Both halves therefore happen HERE, in one call and one transaction, so the two cannot
-- diverge. This does not take the raw capability away, and it is not meant to: a client who
-- deletes the object directly still strands the row and no database rule can stop them. What
-- this function does is make the whole delete the easy path and the only one the portal offers,
-- which is the difference between a divergence that happens by accident and one someone has to
-- go out of their way to cause.
--
-- WHY IT TAKES A SLUG AND A NAME AND NOT AN object_path, and why it derives the key instead of
-- accepting it: the same rule portal_resource_add obeys above, 009's NEVER ACCEPT AN ID. A
-- caller-supplied path is a pointer to bytes, and here it would be a pointer to bytes this
-- function DELETES with the definer's own authority, so `resources/<other-brand>/<sha>` would
-- reach across brands and destroy another client's document. The path used below is the one
-- already recorded on the row this call was authorised to remove, so the only object reachable
-- is the one that row named.
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

  -- AUTHORISE BEFORE EXISTING, the ordering portal_resource_add uses above and 003 and 009
  -- established: a refusal that differs by scope is an enumeration oracle.
  -- auth_can_write_client_slug answers false for a slug that does not exist, for a soft-deleted
  -- brand, for a brand the caller has no membership in, and for a viewer seat, and all four get
  -- this one sentence.
  if not auth_can_write_client_slug(p_client_slug) then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  select c.id into v_cid from clients c
   where c.slug = p_client_slug and c.deleted_at is null;
  if v_cid is null then
    -- Only reachable if the brand was deleted between the predicate and this select. Same
    -- sentence, so the two paths stay indistinguishable.
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;

  -- NO SHAPE CHECKS ON p_name, and the asymmetry with portal_resource_add is deliberate rather
  -- than an oversight. Those checks exist there because that function WRITES, so a blank or
  -- over-long name would reach the browser as a check-constraint 500 instead of a sentence.
  -- This one only MATCHES: a name that is blank, over 255 characters, or simply not one of this
  -- brand's matches no row, and all of them earn the same refusal below. One sentence covering
  -- every miss is also what keeps this from telling a caller which kind of miss they hit.
  --
  -- Keyed on (client_id, name), the same pair the unique constraint uses, so this deletes one
  -- row or none. object_path comes back from the row itself, which is what makes the storage
  -- half below safe: it is a value this call just proved the caller owns.
  delete from client_resources cr
   where cr.client_id = v_cid and cr.name = p_name
   returning cr.object_path into v_path;
  if v_path is null then
    raise exception 'PORTAL:NOTFOUND:no resource named % for this brand', p_name;
  end if;

  -- object_path carries the bucket prefix (`resources/<slug>/<sha256>`) while storage.objects
  -- keys an object WITHOUT it, so the first segment is split off here exactly as server/app.py,
  -- the signed-URL route and sync.materialize_client all split it. On the FIRST slash only: the
  -- key contains a slash of its own and has to survive intact. The bucket is read from the path
  -- rather than hardcoded so a row written under a different bucket cannot have its key applied
  -- to this one.
  v_bucket := split_part(v_path, '/', 1);
  v_key    := substr(v_path, length(v_bucket) + 2);

  -- A MISSING OBJECT IS NOT AN ERROR, and it must not be. portal_resource_add says plainly that
  -- it does not verify the bytes exist before indexing them, so an index row with nothing behind
  -- it is an admitted state of this system rather than an impossible one. Raising on a zero row
  -- count would make exactly that row permanently undeletable, leaving the client a listing entry
  -- they can neither download nor remove, which is worse than the orphan it was trying to report.
  --
  -- WHETHER THIS FUNCTION CAN REACH storage.objects AT ALL depends on whether its OWNER bypasses
  -- RLS, the same uncertainty the note under portal_resource_add names and for the same reason:
  -- on Supabase the migrating role is postgres and it does, but this file cannot verify that
  -- without running. That uncertainty resolves into TWO DIFFERENT FAILURES, and they are not one
  -- event with one outcome. Conflating them is what put a bug here, so they are separated:
  --
  --   RLS FILTERS THE ROW. The delete is a legal statement that matches nothing. row_count comes
  --   back 0, the index row is still removed, the object is orphaned, and the function returns
  --   object_removed = false. That orphan is the divergence this function exists to prevent, but
  --   it is also the state the system is already in today, so it is a floor rather than a
  --   regression, and the false is what makes it visible instead of silent.
  --
  --   THE OWNER LACKS THE DELETE PRIVILEGE on storage.objects. The delete does not come back
  --   empty, it RAISES. Unhandled, that raise aborted the whole function and rolled back the
  --   index delete above with it, so the client pressed delete, read an error, and the resource
  --   could not be removed by any path this product offers. That is precisely the permanently
  --   undeletable row the zero-row rule above refuses to cause, arrived at from the other side.
  --
  -- THE NESTED BLOCK IS WHAT MAKES THE SECOND CASE LEAVE THROUGH THE FIRST CASE'S SIGNAL. A
  -- plpgsql block carrying an exception clause is a subtransaction, so a raise inside it rolls
  -- back to the block's entry and nothing further: the index delete above happened outside that
  -- subtransaction, so it survives untouched and commits with the rest of the call. The storage
  -- half can therefore fail without taking down the half the product's readers actually depend
  -- on, which is the ordering the comment block above already argues for when it calls the orphan
  -- the lesser fault.
  --
  -- THE HANDLER CATCHES `others` DELIBERATELY, and the breadth is the point rather than
  -- carelessness. Every way this statement can raise is a way the object did not get removed: a
  -- missing privilege, a trigger on storage.objects, a schema this role cannot see. The return
  -- value says exactly that and nothing more, so there is no failure here that object_removed =
  -- false would describe wrongly. The warning carries the SQLSTATE into the server log, because
  -- a broad catch with no trace turns three different causes into one indistinguishable false.
  --
  -- v_gone IS ASSIGNED 0 IN THE HANDLER and the assignment is load-bearing, not tidiness: the
  -- raise happens before `get diagnostics` runs, so v_gone would still be null, and `null > 0`
  -- is null rather than false. That would return object_removed as JSON null and every caller
  -- reading it as a boolean would read a third value the contract never had.
  begin
    delete from storage.objects o
     where o.bucket_id = v_bucket and o.name = v_key;
    get diagnostics v_gone = row_count;
  exception
    when others then
      v_gone := 0;
      raise warning 'portal_resource_remove: storage delete of %/% failed (%: %); the index row is removed and the object is orphaned', v_bucket, v_key, sqlstate, sqlerrm;
  end;

  -- The OUTER block still has no exception handler, unlike portal_resource_add, because there is
  -- no constraint here to violate. Two callers removing one name concurrently is already correct:
  -- one delete returns the row and the other returns none and raises NOTFOUND, which is what a
  -- second delete of an already-deleted resource should say. The handler that now exists is the
  -- inner one, scoped to the storage statement alone, and it is scoped that tightly on purpose:
  -- widening it to the whole function would swallow the NOTFOUND and the authorisation refusals
  -- too, which are refusals the caller has to see.
  return jsonb_build_object('name', p_name, 'object_removed', v_gone > 0);
end
$$;

-- WHAT "DELETING THE OBJECT" MEANS HERE, STATED PRECISELY, because a SQL delete and the Storage
-- API's own DELETE are not the same act. Supabase Storage keeps an object's metadata in
-- storage.objects and its bytes in the backing object store, and it is the storage.objects row
-- that every reader resolves: the signed-URL route, a direct download and a bucket listing all
-- answer not-found the moment the row is gone. Removing the row is therefore a complete delete
-- as far as this product, its clients and its agents can observe. What it does not do is the
-- extra step the Storage endpoint takes, removing the stored bytes, so a blob no row references
-- can survive in the backing store. It costs storage, it is content-addressed, and it is
-- unreachable without a row pointing at it, which is a much smaller fault than the index and the
-- bucket disagreeing about what a client owns. It is named here so it is read in a file rather
-- than inferred from a bill.

-- Postgres grants EXECUTE to PUBLIC by default, so revoke first and then grant to
-- `authenticated` alone, exactly as portal_resource_add does above. The reasoning is stronger
-- here, not weaker: this one destroys data, so an unrevoked default would be an unauthenticated
-- delete primitive, and the auth.uid() check inside is not what makes a door safe.
revoke all on function portal_resource_remove(text, text) from public, anon;
grant execute on function portal_resource_remove(text, text) to authenticated;

commit;

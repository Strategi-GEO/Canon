-- Discovery questions: what the crawl could not learn, asked of the person who knows.
--
-- WHY THIS EXISTS. canonical-facts.md is built from two sources that share one blind spot: the
-- brand's uploaded documents and its live site. Both record what the brand has already WRITTEN
-- DOWN. Neither reaches what it simply knows: the price band it never published, the capacity it
-- never listed, the certification that predates the website. §9 of that file already names the
-- claims a session found and could not confirm, and nothing has ever turned that section into a
-- question for the one person who could answer it in ten seconds.
--
-- WHAT IT COST TO NOT HAVE THIS is measured in reviews/blr-brewing-kb-gap.md: 37 of 58 knowledge
-- base subsections never reached the fact base, 6 of 10 planned topics were exposed to the gap,
-- and a fact that is real, held by the client, and unrecorded is INVISIBLE-BUT-FORBIDDEN. Agent R
-- finds it legitimately, Agent W attributes it honestly, Agent E fails it on G7. Discovery then
-- happens once per topic, at the cost of a full research pass plus three eval iterations. This
-- table moves that discovery to onboarding, where it costs one form.
--
-- THIS IS NOT THE EVALUATOR'S QUESTION FORM AND MUST NOT BECOME ONE. That form (review_notes,
-- migration 002) HOLDS A BLOG at any score, is capped at 5, and its answers are owed a revise.
-- These questions hold NOTHING. No blog waits on them, no status turns on them, and a brand with
-- every one unanswered generates exactly as it does today. That is the whole reason a form of 20
-- to 50 is defensible here and indefensible there: the cap of 5 exists because an unanswered form
-- strands an article forever, and nothing here strands anything. Never wire a hold to this table.
--
-- DRAFT UNTIL SENT. sent_at null means the operator has not released the question, and every
-- client-facing read filters on it. Questions arrive from a model, and a model writing directly
-- to a client is the one thing every other outward-facing surface in this app refuses; the
-- operator deletes the weak ones and edits the wording first, exactly as they do before pressing
-- Send to client on a blog.
--
-- APPLY THIS TO THE LIVE DB. The fresh-build mirror lives in schema.sql.

begin;

create table if not exists client_discovery_questions (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,

  -- 'general'      : the set any brand in this industry should be able to answer.
  -- 'personalised' : written against THIS brand's own site, naming its own products and pages.
  -- The split is what the operator reviews by, and what the portal groups the form by.
  kind text not null check (kind in ('general', 'personalised')),

  -- Free text, from the generating session: "Pricing", "Capacity", "Credentials". It is a LABEL
  -- and not an enum on purpose. The themes worth asking about differ by industry, and an enum
  -- here would either be wrong for the next vertical or be widened by every migration after this.
  theme text not null default '' check (length(theme) <= 60),

  question text not null check (btrim(question) <> '' and length(question) <= 400),

  -- What answering it unblocks. The evaluator's form carries the same field, and it is the most
  -- useful line on that screen: it tells the reader whether they are even the right person.
  why text not null default '' check (length(why) <= 400),

  sort_order int not null default 0,

  -- Null until the operator releases it. The client-facing RPCs all filter on it.
  sent_at timestamptz,

  -- Null means unanswered, and unanswered is a PERMANENT, ORDINARY state here. '' is not a valid
  -- answer (the check rejects it) so "they saved a blank" and "they never answered" cannot both
  -- be true of one row; skipping is expressed by leaving the row alone, never by writing ''.
  answer      text check (answer is null or btrim(answer) <> ''),
  answered_at timestamptz,
  answered_by text not null default '',

  created_at timestamptz not null default now(),

  -- answered_at and answer move together or the row lies about whether anybody replied.
  constraint discovery_answer_stamped
    check ((answer is null) = (answered_at is null))
);

create index if not exists client_discovery_client
  on client_discovery_questions (client_id, kind, sort_order);

-- Supabase grants every new public table to authenticated by default, so close it explicitly:
-- nothing reads or writes this table over PostgREST except the definer functions below. The
-- engine reaches it through the service connection, which RLS does not apply to.
alter table client_discovery_questions enable row level security;
revoke all on client_discovery_questions from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Client read: the SENT questions for one brand, with whatever the client has already saved.
--
-- Returns the answers back deliberately. This form is answered over days, not in one sitting, so
-- a client who returns must see what they already said rather than an empty box that reads like
-- their work was lost. Never returns a draft: sent_at is the release gate.
-- ---------------------------------------------------------------------------
create or replace function portal_discovery_questions(p_brand text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', q.id,
             'kind', q.kind,
             'theme', q.theme,
             'question', q.question,
             'why', q.why,
             'answer', q.answer,
             'answered_at', q.answered_at)
           order by q.kind, q.sort_order, q.created_at), '[]'::jsonb)
  from client_discovery_questions q
  join clients c on c.id = q.client_id
  where c.slug = p_brand
    and c.deleted_at is null
    and q.sent_at is not null
    and auth_can_read_client_slug(p_brand);
$$;

-- ---------------------------------------------------------------------------
-- Client write: save ONE answer.
--
-- One question per call, because the form saves as the client types. A whole-form submit would
-- make a 40-question form all-or-nothing, which is the shape the evaluator's form has and the
-- shape that gets abandoned. Re-answering overwrites: a client correcting themselves is not an
-- error, and there is no revise downstream that a changed answer could invalidate.
--
-- A BLANK answer CLEARS the row rather than storing ''. Clearing is how a client takes back an
-- answer they are no longer sure of, and an unsure answer withdrawn is strictly better for the
-- fact base than one left standing.
-- ---------------------------------------------------------------------------
create or replace function portal_answer_discovery(
  p_brand    text,
  p_question uuid,
  p_answer   text
) returns jsonb
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
  v_answer    text := nullif(btrim(coalesce(p_answer, '')), '');
  v_now       timestamptz := now();
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
          select 1 from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no questions to answer for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to answer questions for this brand';
  end if;

  -- The client_id in the predicate is the tenancy check: a question id belonging to another
  -- brand matches no row here and answers NOTFOUND rather than writing across the boundary.
  -- sent_at is checked for the same reason the read filters on it: a draft was never asked.
  update client_discovery_questions q
     set answer      = v_answer,
         answered_at = case when v_answer is null then null else v_now end,
         answered_by = case when v_answer is null then '' else v_email end
   where q.id = p_question
     and q.client_id = v_cid
     and q.sent_at is not null;

  if not found then
    raise exception 'PORTAL:NOTFOUND:that question is not on this brand''s form';
  end if;

  return jsonb_build_object('id', p_question, 'answered', v_answer is not null);
end;
$$;

revoke all on function portal_discovery_questions(text) from public, anon;
grant execute on function portal_discovery_questions(text) to authenticated;
revoke all on function portal_answer_discovery(text, uuid, text) from public, anon;
grant execute on function portal_answer_discovery(text, uuid, text) to authenticated;

commit;

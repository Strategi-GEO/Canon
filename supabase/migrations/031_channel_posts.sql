-- Channel posts: a shipped blog repurposed into ONE channel-native piece (a LinkedIn post,
-- a Medium article), on their OWN track. Deliberately NOT rows in topics / blog_versions /
-- blog_comments, so a channel post can never leak into a blog surface (the Blogs list, the
-- brand blog_count, the ledger, the roadmap red-flags). One post per (source blog, channel).
--
-- The lifecycle mirrors a blog's delivery ladder, minus everything a blog has that a repurpose
-- does not: no score, no eval, no evaluator questions, no ledger. It is generate -> internal
-- review -> send to client -> client requests changes / approves -> admin marks posted. A
-- technical generation failure is surfaced through the run's status feed, exactly as it is for
-- a repurpose today, so no failure column lives here.
--
-- APPLY THIS TO THE LIVE DB. Like migration 030, the fresh-build schema in schema.sql carries a
-- mirror of these statements; this file is what brings an existing database up to it.

create table if not exists channel_posts (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  -- The blog this piece was cut from. A channel post is meaningless without its source, so the
  -- FK cascades: delete the blog and its posts go with it.
  source_topic_id uuid not null references topics(id) on delete cascade,
  channel         text not null check (channel in ('linkedin','medium')),

  -- The post markdown, the committed artifact. Edited in place (a channel post has no versions:
  -- a client suggestion anchors to the current body, not to a pinned release, because there is
  -- no re-generation loop that reflows it out from under a comment).
  body            text not null default '',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- The delivery stamps, mirroring topics (004, 005). sent re-stamps on every send and clears
  -- the approval below, because an approval describes the exact bytes the client read.
  sent_to_client_at  timestamptz,
  sent_to_client_by  text,
  client_approved_at timestamptz,
  client_approved_by text,

  -- The one act that is NOT a blog's: the admin marking the piece live on the channel. There is
  -- no CMS push for a channel post (the client posts it themselves), so this is a plain stamp,
  -- reachable only once the client has approved.
  posted_at       timestamptz,
  posted_by       text,

  -- One piece per (blog, channel); a regenerate overwrites the body in place.
  unique (source_topic_id, channel),
  -- Composite-FK target, exactly like topics: a comment whose client_id disagrees with its
  -- post's is rejected by the database, not by a code path someone has to remember.
  unique (id, client_id)
);

create index if not exists channel_posts_client on channel_posts (client_id);
create index if not exists channel_posts_source on channel_posts (source_topic_id);

-- The selection comments on a channel post, its own table so the blog machinery stays untouched.
-- Same state machine as blog_comments (open -> applying -> resolved | failed | dismissed) and the
-- same author split, because the admin resolve-with-Claude flow and the client's request-changes
-- flow are identical in shape; only the artifact they edit differs. No replies (the blog reply
-- feature is removed) and no approved-lock trigger (a channel post has no re-generation, so the
-- only writer after approval is the admin marking it posted, which touches no comment).
create table if not exists channel_post_comments (
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

create index if not exists channel_post_comments_post
  on channel_post_comments (channel_post_id, created_at);

-- RLS + the client-safe column boundary, exactly the model the blog tables use (schema.sql). The
-- local engine and local admin reach Postgres as the table OWNER and bypass all of this; the
-- hosted client portal reads as `authenticated`, row-scoped to its own org, safe columns only.
-- The _by columns are person emails and stay off the grant.
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

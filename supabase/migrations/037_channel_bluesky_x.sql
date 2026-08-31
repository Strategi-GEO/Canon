-- 037_channel_bluesky_x.sql
-- Two more repurpose channels: bluesky and x. Widens ONE check constraint and nothing else.
--
-- WHY THIS IS THE WHOLE MIGRATION. 031 built channel_posts to be channel-generic: the channel is
-- a column, not a table, and every index, grant, RLS policy, unique key and cascade above it is
-- keyed on (source_topic_id, channel) rather than on a channel's name. 032's two portal RPCs take
-- p_channel as a parameter and resolve the post row from it, so they inherit both new channels
-- with no change and no re-grant. That leaves exactly one place in the database that enumerates
-- channels, and this file is it.
--
-- NAMED, NOT ANONYMOUS. 031 wrote the check inline, so Postgres generated `channel_posts_channel_check`.
-- Dropping by that generated name is what makes this migration re-runnable on a database built
-- from 031 as written. The replacement is named EXPLICITLY, so migration 038 does not have to
-- guess what Postgres called this one.
--
-- 'x', NOT 'twitter'. The product is called X, the tab is called X, the skill is x-repurposer, and
-- outputs/<client>/<topic>/repurpose/x/ is the artifact dir. One spelling from the URL down to the
-- filesystem means no translation layer anywhere, and a rename later is a data migration this
-- avoids ever needing.
--
-- NOTHING IN HERE MAKES A CHANNEL AUTOMATIC. The CMS publish hook fires a subset named in Python
-- (repurpose.AUTO_CHANNELS), not one derived from this constraint, so admitting a channel to the
-- database admits it to the tabs and the review loop and leaves generation manual. That split is
-- deliberate: bluesky and x are select-then-Generate only.
--
-- SAFE ON A LIVE DB: the new constraint is strictly WIDER than the one it replaces, so every
-- existing row satisfies it and the validating scan cannot fail. No rewrite, no lock beyond the
-- brief ACCESS EXCLUSIVE the ALTER takes.

alter table channel_posts drop constraint if exists channel_posts_channel_check;
alter table channel_posts drop constraint if exists channel_posts_channel_allowed;
alter table channel_posts add constraint channel_posts_channel_allowed
  check (channel in ('linkedin','medium','bluesky','x'));

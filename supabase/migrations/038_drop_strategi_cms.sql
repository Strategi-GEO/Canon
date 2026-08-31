-- 038: the Strategi CMS stops being a destination.
--
-- WHAT CHANGED ABOVE THIS FILE. Canon published to two places: a brand's own website, and the
-- Strategi CMS, which took a DRAFT one of our editors reviewed. The second is gone. Every brand
-- now publishes to its own website or it publishes nowhere, and "nowhere" is a disabled Post
-- button naming the setting rather than a silent fallback. server/cms/sites.py no longer carries
-- the kind, server/cms/client.py is deleted, and gate.assert_client_approved no longer exempts
-- anything: a push is a live release on a client's domain, so it waits for the client's approval.
--
-- WHY THE ROWS HAVE TO MOVE AND CANNOT BE LEFT. Migration 035 stamped '{"kind": "strategi-cms"}'
-- onto every brand that existed at the time, so doing nothing here leaves those brands pointing
-- at a destination this build has no driver for. That is not a harmless stale value: it PASSES
-- gate.assert_destination, which only tests for emptiness, and the refusal an operator would then
-- meet is the route's "this version of Canon cannot post to it" 409, one press and one round trip
-- later. Clearing them to '{}' puts those brands into the state they are actually in, which is
-- the state the Post button is built to explain: no website connected yet.
--
-- SCOPED TO THE CMS KIND ALONE, so a brand somebody has already connected to WordPress keeps its
-- destination and its credential. Re-runnable for the same reason: a second run matches nothing.
update clients
   set site = '{}'::jsonb
 where site->>'kind' = 'strategi-cms';

-- topics.published_to IS DELIBERATELY UNTOUCHED, and this is the half of the change that must not
-- be tidied. It records where an article WENT, not where the brand publishes now, and articles
-- really did go to the Strategi CMS. Rewriting or clearing that column would make the record
-- assert those pushes never happened, which is exactly the history-rewriting that 035 added the
-- column to prevent. The dashboard still renders a 'strategi-cms' value on an old article for the
-- same reason.

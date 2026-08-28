-- 035_client_site.sql
-- Where a brand's finished blogs are published, and the credential that gets them there.
--
-- WHAT THIS REPLACES. Until now there was exactly one destination, the Strategi CMS, reached
-- with one shared write key held in the engine's environment (server/cms/client.py). A brand
-- that wanted its blogs on its OWN website had no route at all, and the workaround, adding
-- per-client secrets to a deployment's environment and redeploying, stores per-client facts in
-- the DEPLOY layer: a new client is a redeploy, rotating one client's key re-deploys everybody,
-- and nothing records who changed what. This column moves that config into the DATA layer, where
-- every other per-brand fact already lives (market, custom_instructions, cms_client). A new
-- destination is a form submit. There is no deploy, no restart, and no new environment variable.
--
-- ONE jsonb COLUMN, NOT SIX, and `gates` is the precedent. The shape differs per platform (a
-- WordPress connection carries a username and an application password, a Shopify one carries a
-- shop domain and an admin token) while the column does not, so adding a platform costs a driver
-- file and no migration at all.
--
-- OPERATOR MATERIAL, AND MORE SO THAN ANY COLUMN BEFORE IT: this one holds a WRITE CREDENTIAL for
-- a client's live website. It is deliberately absent from the authenticated re-grant below, like
-- custom_instructions and cms_client, so a JWT taken straight to PostgREST cannot read it. The
-- engine reads it over the owner connection, which bypasses column grants entirely, and
-- server/clients.py reads it through its OWN query rather than through _CLIENT_SELECT, because
-- GET /api/clients/{slug} answers to require_user rather than require_admin and everything in
-- that select reaches any logged-in user.
--
-- THE BACKFILL IS THE WHOLE OF WHAT KEEPS THIS SAFE ON A LIVE DB. Every existing brand publishes
-- to the Strategi CMS today, so every existing brand is stamped with that destination here. The
-- publish route reads this column and refuses a brand with no destination, so an unbackfilled
-- row would silently stop a brand that was working this morning. New brands start empty and must
-- be configured before their first post, which is the point: "no destination" becomes a state the
-- app can name and refuse on, instead of an implicit fallback nobody chose.
--
-- SAFE ON A LIVE DB: three additive columns, one backfill of an added column, two grants.
-- Idempotent: add column if not exists, and the backfill is scoped to rows still holding the
-- default so re-running it cannot overwrite a destination someone has since configured.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/035_client_site.sql

begin;

-- ---------------------------------------------------------------------------
-- The destination, per brand
-- ---------------------------------------------------------------------------
alter table clients add column if not exists site jsonb not null default '{}'::jsonb;

-- Every brand that exists today publishes to the Strategi CMS. Stamp them, so the publish
-- route's new "is a destination configured" refusal cannot fire on a brand that was fine
-- before this migration ran.
--
-- `= '{}'` and not `is null`: the column is not null with a default, so an unconfigured row
-- holds the empty object. Scoping the update to it makes this re-runnable.
update clients set site = '{"kind": "strategi-cms"}'::jsonb where site = '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- What a push to a client's own website leaves behind
-- ---------------------------------------------------------------------------
-- 012 added published_at, published_by, cms_post_id, cms_slug and cms_status for the CMS push.
-- Those five carry over unchanged: a remote post has an id, a slug and a status wherever it
-- lives, and a blog goes to exactly ONE destination, so they never need to hold two at once.
-- The `cms_` prefix is now a legacy name for "the remote article", and renaming five columns
-- across record.py, blog-state.ts, the portal and the grants below would be churn bought for
-- cosmetics. These two are what the prefix genuinely cannot cover.

-- The published article's own URL, as the destination reported it. NOT derived, and that is the
-- point: permalink structure is a per-site setting (/insights/slug/, /2026/08/slug/, /?p=412),
-- so building this from cms_slug would be a guess that is wrong on a good fraction of sites.
-- Every platform's create call returns the real link in the same response that makes the post,
-- so the honest value is free and there is no reason to invent one.
alter table topics add column if not exists cms_url text;

-- WHERE this article went: 'strategi-cms', or the client's own host ('acme.com'). Without it,
-- switching a brand's destination silently rewrites history: every article it ever published
-- would read as having gone to the new place. The destination on clients.site is the CURRENT
-- config; this is where THIS article actually landed.
alter table topics add column if not exists published_to text;

-- 003 made topics column-scoped for `authenticated` (revoke table, grant safe columns), and a
-- hosted route that selects an ungranted column has its WHOLE request refused by PostgREST: a
-- 502 for every caller of that route, not a missing field. Both columns are rendered by the
-- blog surfaces (the "View on acme.com" link and the destination label), so both are granted.
-- Neither carries a credential: they are a public URL and a hostname.
grant select (cms_url, published_to) on topics to authenticated;

-- admin_topics is `select * from topics`, and a star in a view is expanded at creation time
-- into a fixed column list stored in the rewrite rule, so the existing view does not know these
-- two columns exist. Replacing it re-expands the star, which is legal for `create or replace
-- view` because the added columns land at the END of the list. Same reasoning as 012.
create or replace view admin_topics as
  select * from topics where auth_is_admin();

-- 006 flipped every admin_* view to definer semantics, and this re-asserts it rather than
-- trusting the replace to carry the reloption. With security_invoker = true the view runs as
-- the CALLER, whose grants 003 revoked, so it returns nothing to everybody.
alter view admin_topics set (security_invoker = false);

commit;

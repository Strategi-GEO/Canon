# Deploying Strategi Canon to Vercel (hosted, read-only mode)

## The two modes, in five sentences

The same dashboard codebase runs two ways. LOCAL is the full-featured mode: the browser
talks straight to the FastAPI engine (`NEXT_PUBLIC_API_BASE=http://localhost:8000`, which is
also the dev default), and generation, uploads, edits, runs and the SSE live view all work.
HOSTED is this Vercel deployment: `NEXT_PUBLIC_API_BASE` is deliberately unset, so
`API_BASE` falls back to `""` (same origin) and every existing fetch lands on the Next.js
Route Handlers under `/api/*`, which verify the caller's Supabase JWT and read Supabase
directly (PostgREST as the user, so Row Level Security scopes every answer). Hosted is
strictly read-only: the handlers expose no data-mutating method, and
`NEXT_PUBLIC_HOSTED_READONLY=true` hides every control that needs the live engine (generate,
stop, uploads, edits, answers, CMS publish). Login is unchanged in both modes because the
hosted `/api/login`, `/api/refresh` and `/api/logout` proxy GoTrue with the same contract
shape the engine uses.

## Vercel project settings

- **Root Directory**: `dashboard`.

  Exactly that, with no prefix. `geo-factory` is the name of the folder this repository is
  checked out INTO on a laptop, not a path inside it: the repo root IS geo-factory, and
  `git ls-tree HEAD` shows `dashboard` at the top level beside `server` and `clients`. This
  line used to read `geo-factory/dashboard`, which does not exist in the repository, and
  Vercel fails that before it runs a single build step.

  Setting it matters in the other direction too. Left at the repo root, Vercel finds
  `requirements.txt` and no `package.json`, misdetects the project as Python, and never
  builds the app at all.
- **Framework Preset**: Next.js (auto-detected). Default build command (`next build`) and
  output settings are correct.
- **Node version**: 20.x or later (Next.js 16 requires Node >= 20; the default on Vercel is
  fine, just do not pin it below 20).

## Environment variables (Project Settings -> Environment Variables)

| Name | Value | Why |
|---|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | GoTrue proxy target, JWKS source, and PostgREST base. Server-side only. |
| `SUPABASE_ANON_KEY` | the project's anon/publishable key | Sent as `apikey` to GoTrue and PostgREST. The user's own JWT does the authorizing; RLS does the scoping. Server-side only. |
| `NEXT_PUBLIC_HOSTED_READONLY` | `true` | Switches the UI into read-only gating and keeps the dev localhost fallback off. |
| `NEXT_PUBLIC_API_BASE` | **do not set** | Unset means same-origin, which is what routes every fetch to the `/api/*` handlers above. |

`NEXT_PUBLIC_HOSTED_READONLY` is inlined into the client bundle at BUILD time, not read at
request time, so it has to be set before the first build. Adding it afterwards needs a
redeploy: until then the UI ships with every engine-dependent control visible, and each one
fails against an engine that is not there.

The Supabase SECRET key is not used anywhere in this dashboard, with zero exceptions, and
must not be added to the Vercel env.

## Migrations this deployment requires

Apply these in order before pointing a deployment at a Supabase project. Missing any one of
them does not fail the build; it fails the app at runtime, which is harder to diagnose.

| Migration | What breaks without it |
|---|---|
| `001_auth_identity.sql` | RLS policies and the `authenticated` grants. Every read comes back empty. |
| `002_client_portal.sql` | The client portal's tables and definer functions. |
| `003_portal_column_guard.sql` | Clients can read scores, eval bodies, dossiers and the fact base straight off PostgREST. |
| `004_send_to_client.sql`, `005_client_review.sql` | The admin review loop: send, comments, replies, approval. |
| `006_admin_views_definer.sql` | **The dashboard is unusable.** 003's admin views are security_invoker, so they hit the grants they exist to bypass: `/api/me` answers 502 and the site root cannot route anyone anywhere. |
| `007_admin_rollup_views.sql` | Per-blog status and score, and per-client blog counts, both 502. |
| `008_admin_roadmap_sheets.sql` | The roadmap sheet preview and the generation report both 502. |
| `009_admin_write_tier.sql`, `010_admin_write_tier_fixes.sql`, `011_admin_reply_comment.sql` | **The hosted build becomes read-only in fact.** Send to client, comments, replies, dismiss, manual edits, brand settings, roadmap delete and blog upload all 404 or 403. 010 and 011 are not optional refinements: without 010, dismissing a comment DELETES it and cascades away its replies, and saving an edit blanks the score so a shipped blog reads as uploaded; without 011 the Reply control posts to a route that does not exist. |
| `012_publish_tracking.sql` | The record never learns a blog reached the CMS. No publish stamp is written and no Published chip appears anywhere. Harmless to omit, and invisible rather than broken. |

006 through 008 exist specifically because 003 hardened the column grants and left the
hosted admin surface with no legal route to the columns it legitimately reads. They add no
base-table grant: every one is a definer view gated on `auth_is_admin()`, so a client's JWT
still cannot reach a score or a dossier by any path.

009 through 011 are the write half of that same story. Each is a `security definer` function
that re-checks `auth_is_admin()` itself, so authority lives in the database rather than in a
route handler: RLS stays SELECT-only and no base table gains an INSERT or UPDATE grant.

012 adds five columns to `topics` and grants exactly one of them, `published_at`, to
`authenticated`. The four it withholds are an operator email and three CMS-internal fields
that no client surface renders. **Its null has one meaning and it is not the obvious one:**
a null `published_at` means "no record of a push", never "not published". There was nothing
to backfill from, so every blog pushed before 012 reads as null, and every surface therefore
renders the Published chip only when the stamp exists and stays silent otherwise.

## What a hosted deployment cannot show

Everything the engine writes is in Supabase, so a hosted reader sees the blogs, evals,
dossiers, status trails, roadmaps, ledger and review threads. Two gaps are structural and
worth knowing before anyone reports them as bugs:

- **Resource file CONTENTS.** Uploads live in the private `resources` Storage bucket, which
  has no `storage.objects` policy and is reachable only with the Supabase secret key. That
  key is deliberately not in this app, so the hosted Resources tab lists names and sizes and
  cannot download a file. Closing this means either a signed-URL route holding the secret
  key server-side, or a bucket policy, and both are decisions rather than oversights.
- **Anything that needs the engine.** The line is CLAUDE-OR-NOT for everything except the CMS
  push, and it is worth stating as a list because "hosted is read-only" stopped being true at
  migration 009 and the old wording sent people looking for bugs that were design.

  | Act | Hosted | Why |
  |---|---|---|
  | Generate a blog, revise, stop a run, resolve a comment with Claude | No | An Agent SDK session, which needs a machine and the teammate's own Claude billing. |
  | Roadmap generation, describe a brand | No | Same. |
  | The live SSE run feed | No | Nothing is running to stream. `/api/runs` is a stub returning `{runs: []}`, which keeps every poller quiet rather than erroring. |
  | Run `gates.py` on an upload | No | A subprocess, and Vercel has none. The upload still commits; it reports `gates: {ran: false, reason}` and can never report `passed: true`. |
  | Resource file downloads | No | See above. |
  | **CMS publish** | **No, and this one is a choice rather than a limit** | Nothing in the push touches Claude: it reads the committed markdown, transforms it deterministically and POSTs it. It stays local because porting `server/cms/payload.py` would mean a second implementation of a 548-line transform whose `source_run_id` must reproduce Python's `uuid5` byte for byte, and because the write key would then have to live in this deployment's env, ending the property that a leaked env here cannot mutate anything. The record still LEARNS about pushes (012), so the hosted build shows that a blog went out even though it cannot send it. |
  | Send to client, add or reply to or dismiss a comment, manual edits, brand settings, roadmap delete, blog upload | **Yes** | Plain database writes, performed by the definer functions in 009 to 011. |

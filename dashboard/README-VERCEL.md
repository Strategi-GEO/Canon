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

006 through 008 exist specifically because 003 hardened the column grants and left the
hosted admin surface with no legal route to the columns it legitimately reads. They add no
base-table grant: every one is a definer view gated on `auth_is_admin()`, so a client's JWT
still cannot reach a score or a dossier by any path.

## What a hosted deployment cannot show

Everything the engine writes is in Supabase, so a hosted reader sees the blogs, evals,
dossiers, status trails, roadmaps, ledger and review threads. Two gaps are structural and
worth knowing before anyone reports them as bugs:

- **Resource file CONTENTS.** Uploads live in the private `resources` Storage bucket, which
  has no `storage.objects` policy and is reachable only with the Supabase secret key. That
  key is deliberately not in this app, so the hosted Resources tab lists names and sizes and
  cannot download a file. Closing this means either a signed-URL route holding the secret
  key server-side, or a bucket policy, and both are decisions rather than oversights.
- **Anything that needs the engine**: generation, revise, stop, uploads, edits, CMS publish,
  and the live SSE run feed. `NEXT_PUBLIC_HOSTED_READONLY=true` hides all of it.

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

- **Root Directory**: `geo-factory/dashboard` (this folder; Vercel must build the Next.js
  app, not the repo root).
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

The Supabase SECRET key is not used anywhere in this dashboard, with zero exceptions, and
must not be added to the Vercel env. Apply `supabase/migrations/001_auth_identity.sql`
(RLS read policies and grants for the `authenticated` role) before pointing this deployment
at a project, or every data read will come back empty.

/**
 * The ONE switch for the hosted, read-only deployment.
 *
 * The same codebase runs two ways. LOCAL points NEXT_PUBLIC_API_BASE at the FastAPI engine
 * and every feature works. HOSTED runs on Vercel with no engine behind it: the /api Route
 * Handlers answer every read straight from Supabase, and everything that needs the live
 * engine (generation, runs, uploads, edits, the CMS push) is hidden or disabled in the UI.
 *
 * NEXT_PUBLIC_ so it is inlined at build time and readable in client components. Components
 * gate on this constant and nothing else, so "is this the read-only build" has exactly one
 * answer everywhere.
 */
export const HOSTED_READONLY = process.env.NEXT_PUBLIC_HOSTED_READONLY === "true";

import type { NextConfig } from "next";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// SELF-HOSTED PRODUCTION BUILD, DESKTOP APP ONLY. `standalone` emits `.next/standalone/server.js`,
// a self-contained Node server, so the packaged desktop app serves an ALREADY-COMPILED dashboard
// instead of running `next dev`. It is gated behind CANON_STANDALONE and OFF by default, which is
// the whole point: the Vercel deployment of the client-facing dashboard never sets that flag, so
// it builds with the EXACT config it always had and nothing about the hosted site changes. Only
// the desktop build (CI sets CANON_STANDALONE=1 before `next build`) turns it on.
// outputFileTracingRoot pins the standalone root to this folder so server.js lands at
// `.next/standalone/server.js`, not nested under an inferred monorepo root.
const standalone =
  process.env.CANON_STANDALONE === "1"
    ? {
        output: "standalone" as const,
        outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
      }
    : {};

const nextConfig: NextConfig = {
  ...standalone,

  // No rewrite proxy to the FastAPI engine on purpose. The dashboard calls it cross origin
  // from the browser so the SSE run feed streams straight from the engine, and a proxy hop
  // would buffer those frames and stall the live view. CORS is configured server side.
  reactStrictMode: true,

  // ONE APP, ONE DEPLOYMENT. Admin and client are the same Next app on one origin (one
  // Vercel project): the admin interface lives under the /admin route segment (app/admin/*)
  // and the client portal at the root (/{brand} or /{org}/{brand}), chosen by the signed-in
  // account. No basePath, because basePath would confine the whole app under one prefix and
  // leave no room for the client routes at the root. The FastAPI engine calls are cross
  // origin and unaffected (API_BASE).

  // No floating dev-tools badge: it overlaps the sidebar's attention pills and the card tags
  // in dev, and it photographs into every screenshot as apparent UI. Dev-only either way.
  devIndicators: false,
};

export default nextConfig;

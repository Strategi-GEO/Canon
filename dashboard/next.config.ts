import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

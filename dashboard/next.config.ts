import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No rewrite proxy to the FastAPI engine on purpose. The dashboard calls it cross origin
  // from the browser so the SSE run feed streams straight from the engine, and a proxy hop
  // would buffer those frames and stall the live view. CORS is configured server side.
  reactStrictMode: true,
};

export default nextConfig;

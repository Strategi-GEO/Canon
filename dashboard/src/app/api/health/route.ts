import { json } from "@/lib/server/http";

/** Mirrors the engine's GET /api/health: the one unauthenticated liveness probe. */
export async function GET() {
  return json({ ok: true });
}

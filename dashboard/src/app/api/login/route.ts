import { login } from "@/lib/server/auth";
import { MissingEnv } from "@/lib/server/env";
import { detail, failure, json } from "@/lib/server/http";

/**
 * The GoTrue password-grant proxy, mirroring the engine's POST /api/login: the browser never
 * holds a Supabase key, and the response is EXACTLY the session contract shape. One 401
 * message for every failure mode, so the response never says which of email or password was
 * wrong.
 */
export async function POST(request: Request) {
  let body: { email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with email and password is required");
  }
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return detail(422, "a JSON body with email and password is required");
  }
  try {
    return json(await login(body.email, body.password));
  } catch (cause) {
    if (cause instanceof MissingEnv) {
      return failure(cause);
    }
    return detail(401, "invalid email or password");
  }
}

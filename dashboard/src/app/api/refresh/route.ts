import { refresh } from "@/lib/server/auth";
import { MissingEnv } from "@/lib/server/env";
import { detail, failure, json } from "@/lib/server/http";

/** The refresh-token grant, same contract shape as login, 401 when GoTrue refuses. */
export async function POST(request: Request) {
  let body: { refresh_token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with refresh_token is required");
  }
  if (typeof body.refresh_token !== "string") {
    return detail(422, "a JSON body with refresh_token is required");
  }
  try {
    return json(await refresh(body.refresh_token));
  } catch (cause) {
    if (cause instanceof MissingEnv) {
      return failure(cause);
    }
    return detail(401, "invalid refresh token");
  }
}

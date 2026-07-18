import { MissingEnv } from "@/lib/server/env";

/**
 * Response helpers for the hosted-mode Route Handlers, shaped like the FastAPI engine's
 * answers so src/lib/api.ts cannot tell the two servers apart: errors are {"detail": ...},
 * artifacts are text/plain, and 204s carry no body.
 */

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function detail(status: number, message: unknown): Response {
  return Response.json({ detail: message }, { status });
}

export function text(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/**
 * The one catch-all every handler funnels unexpected failures through. Config gaps say so
 * plainly (the operator forgot an env var on Vercel); anything else is a 502 naming the hop
 * that failed, because "something went wrong" helps nobody read a log.
 */
export function failure(cause: unknown): Response {
  if (cause instanceof MissingEnv) {
    return detail(500, cause.message);
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return detail(502, `upstream request failed: ${message}`);
}

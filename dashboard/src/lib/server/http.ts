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
 * The ONE refusal every hosted admin write returns, and the ONE place its sentence is written.
 *
 * THE HOSTED SITE PERFORMS NO ADMIN WRITE, AND THIS IS THE ANSWER THAT MAKES THAT TRUE RATHER
 * THAN MERELY LOOKING TRUE. The web deployment is a view-and-preview window over the record: an
 * admin reads blogs and their status there, and every act that changes something happens in the
 * Canon app on their own machine. Hiding a control in the browser does not make that so, because
 * the routes stay reachable from a stale tab, from a bookmarked fetch, and from curl holding a
 * perfectly valid admin JWT, so the refusal has to be on the server.
 *
 * IT LIVES HERE RATHER THAN IN THE ROUTES BECAUSE ONE CODEBASE SERVES BOTH BUILDS. Every new
 * admin write route needs this gate, and a sentence pasted into eight handlers is a sentence
 * that eventually is not pasted a ninth: the route ships, the hosted build reaches for a Python
 * engine that is not deployed, and the operator gets a network error where a paragraph should
 * be. One call is what keeps the website from growing that button. It also means the wording is
 * edited once, so the eight answers cannot drift into eight slightly different explanations of
 * the same rule.
 *
 * 501 rather than 403, and the reasoning is the one admin-rpc.ts already spells out for its
 * LOCKED code. The caller's account is permitted to do this and would be obeyed by the same
 * route running locally, so 403 would read as "your account cannot do this" and send an admin
 * hunting for a permission they already hold. 501 says what is actually the case: this server
 * does not implement the act, and another one does.
 *
 * `act` completes the sentence "Open the Canon app on your own machine to ...", so it is a verb
 * phrase naming what the caller was trying to do, without a trailing period. Naming the specific
 * act is the point: "this is read-only" tells an operator nothing they can act on, while "to send
 * this blog to the client" tells them which window to go open and what to do once they are there.
 *
 * EVERY CALLER GATES AHEAD OF verifyRequest ON PURPOSE. Whether this deployment writes at all is
 * a property of the deployment and not of the caller, so there is nothing about the caller worth
 * establishing first: answering immediately spends no JWKS round trip and keeps the gate the
 * first thing anyone reads in the handler.
 *
 * This builds the response and does not read HOSTED_READONLY itself, so the gate stays visible at
 * the top of each handler where that ordering can be seen, and this module stays free of the
 * build switch. HOSTED_READONLY is false in the local app, so everything below each call site
 * behaves exactly as it always has and the local build is untouched by construction.
 */
export function hostedWriteRefused(act: string): Response {
  return detail(
    501,
    `The hosted Strategi Canon site is a read-only window on the record: it shows blogs and their status, and it performs no admin action. Open the Canon app on your own machine to ${act}.`,
  );
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

/**
 * isTokenRejection decides whether a PostgREST failure means "your session is stale, log in
 * again" (a 401 the api layer self-heals into a fresh login) or "the backend is broken" (a 502).
 *
 * The regression this pins is the exact bug it was written to fix: a stale session token
 * verified at the Next.js layer (jose/JWKS) but was rejected by PostgREST, whose 401 was masked
 * as a 502, so the root page dead-ended on "could not open your workspace" instead of re-logging
 * the caller in. The load-bearing half is the OTHER direction: a 42501 permission-denied is also
 * a 401, and treating IT as a token rejection would log every user out over a grants fault a
 * fresh login cannot touch. That 42501-is-401 case is the live PostgREST response, verified
 * against the project's own REST endpoint.
 *
 * Run it with:  node --test tests/token-rejection.test.ts        (from dashboard/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PostgrestError, isTokenRejection } from "../src/lib/server/postgrest.ts";

test("PGRST301 (PostgREST's JWT error) at 401 is a token rejection", () => {
  assert.equal(
    isTokenRejection(new PostgrestError(401, "jwt", { code: "PGRST301", message: "JWSError" })),
    true,
  );
});

test("42501 permission-denied at 401 is NOT a token rejection (grants fault, stays a 5xx)", () => {
  // The live response: `{"code":"42501","message":"permission denied for table clients"}`, HTTP 401.
  assert.equal(
    isTokenRejection(
      new PostgrestError(401, "permission denied", {
        code: "42501",
        message: "permission denied for table clients",
      }),
    ),
    false,
  );
});

test("any 5-char Postgres SQLSTATE at 401 is NOT a token rejection", () => {
  assert.equal(
    isTokenRejection(new PostgrestError(401, "undefined table", { code: "42P01" })),
    false,
  );
});

test("a bare 401 with no code is a token rejection (PostgREST refused the token itself)", () => {
  assert.equal(isTokenRejection(new PostgrestError(401, "unauthorized", null)), true);
});

test("a 401 whose message names the JWT is a token rejection even with no code", () => {
  assert.equal(
    isTokenRejection(new PostgrestError(401, "JWT expired", { message: "JWT expired" })),
    true,
  );
});

test("a non-401 PostgREST error is never a token rejection", () => {
  assert.equal(isTokenRejection(new PostgrestError(502, "bad gateway", null)), false);
  assert.equal(isTokenRejection(new PostgrestError(404, "not found", { code: "PGRST116" })), false);
});

test("a non-PostgrestError cause is never a token rejection", () => {
  assert.equal(isTokenRejection(new Error("network down")), false);
  assert.equal(isTokenRejection(null), false);
  assert.equal(isTokenRejection({ status: 401 }), false);
});

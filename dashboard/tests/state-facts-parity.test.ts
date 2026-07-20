/**
 * TWO PRODUCERS, ONE FACT SET, CHECKED RATHER THAN ASSERTED.
 *
 * Run it with:  node --test tests/state-facts-parity.test.ts        (from dashboard/)
 *
 * lib/server/portal-data.ts builds the client portal's blogs and app/api/clients/[slug]/blogs
 * /route.ts builds the hosted admin list. They read the same record through the same PostgREST
 * client and they hand their facts to the same blogState, so a field one supplies and the other
 * omits does not make the two surfaces show different things on purpose. It makes one of them
 * take a fallback the other never takes, and derive a different state from an identical row.
 *
 * IT HAS HAPPENED TWICE AND IN BOTH DIRECTIONS, which is why this file exists. `answers_submitted`
 * reached the hosted route first, so the portal read an answered hold as `has_questions` and put a
 * client in front of a form they had already submitted. `change_round_open` reached the hosted
 * route first, so the portal fell back to `(changes_requested ?? 0) > 0`, the open COUNT, which
 * hits zero the moment the team resolves the last suggestion while the round is still open: the
 * portal derived `client_review`, whose CLIENT_ACTIONS grant approve and suggest, over an article
 * the hosted list was calling `changes_requested` and whose fix had not been delivered yet.
 *
 * WHY IT READS THE SOURCE RATHER THAN CALLING THE PRODUCERS. Neither one can be imported here.
 * Both resolve `@/...` path aliases that node's own loader does not know, both pull the PostgREST
 * client, and the route is a Next request handler that answers nothing without a database. This
 * suite deliberately has no framework, no bundler and no build step between the source and the
 * check, and buying one to import two object literals would cost more than reading them.
 *
 * WHAT IT ADDS OVER THE TYPE. ProducedStateFacts already forces both literals to carry the same
 * keys, and that is the primary mechanism: it fails at compile time, at the producer that dropped
 * the fact, and it fails BOTH producers when a field is added to BlogStateFacts. Its one hole is
 * that a type is only load-bearing while a literal still names it, and dropping an annotation is a
 * one-character edit that nothing else reports. This test holds the literals to each other with no
 * reference to the annotation at all, so removing the type does not remove the check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const STATE_FILE = join(SRC, "lib", "blog-state.ts");
const PORTAL_FILE = join(SRC, "lib", "server", "portal-data.ts");
const HOSTED_FILE = join(SRC, "app", "api", "clients", "[slug]", "blogs", "route.ts");

/**
 * Comments out, then keys. Every one of these files explains itself at length in prose, and a
 * sentence like "the round, not the queue:" reads as a key to a naive regex. Stripping first is
 * what makes the extraction below a fact about the code rather than about the commentary.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The top-level keys of one brace-delimited region, found by depth so nested objects are ignored. */
function keysOfRegion(source: string, openIndex: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let line = "";
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    if (ch === "\n") {
      line = "";
      continue;
    }
    line += ch;
    // Depth 1 is the region's own body. A key match is recorded the moment its colon arrives, so
    // anything nested inside a value has already pushed the depth past 1 and is skipped.
    if (ch === ":" && depth === 1) {
      const match = /^\s*(\w+)\??\s*:$/.exec(line);
      if (match !== null) {
        keys.push(match[1]);
      }
    }
  }
  return keys;
}

function keysAfter(file: string, marker: string): string[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${file} no longer contains '${marker}', so this test is checking nothing`);
  const open = source.indexOf("{", at + marker.length - 1);
  assert.notEqual(open, -1, `no object literal follows '${marker}' in ${file}`);
  return keysOfRegion(source, open);
}

const sorted = (keys: string[]): string[] => [...keys].sort();

test("both producers hand blogState the same fact set", () => {
  const portal = keysAfter(PORTAL_FILE, "const stateFacts");
  const hosted = keysAfter(HOSTED_FILE, "const stateFacts");

  // Non-empty first, so a refactor that moves the literal somewhere this test cannot find fails
  // loudly here instead of passing two empty sets against each other.
  assert.ok(portal.length > 0, "extracted no facts from the portal producer");
  assert.ok(hosted.length > 0, "extracted no facts from the hosted producer");

  assert.deepEqual(
    sorted(portal),
    sorted(hosted),
    "one producer supplies a fact the other omits, so the two derive different states from one " +
      "record. Supply it in both, or exempt it in ProducedStateFacts with the reason written out.",
  );
});

test("the facts they omit are exactly the ones ProducedStateFacts exempts", () => {
  const declared = keysAfter(STATE_FILE, "export type BlogStateFacts");
  const produced = new Set(keysAfter(PORTAL_FILE, "const stateFacts"));

  const portalSource = stripComments(readFileSync(PORTAL_FILE, "utf8"));
  const omit = /Omit<\s*BlogStateFacts\s*,([^>]*)>/.exec(portalSource);
  assert.notEqual(omit, null, "ProducedStateFacts no longer omits anything from BlogStateFacts");
  const exempt = new Set([...(omit as RegExpExecArray)[1].matchAll(/"(\w+)"/g)].map((m) => m[1]));

  // THE POINT OF THIS SECOND TEST is the field nobody adds anywhere. The first test passes when
  // both producers omit a new fact, because they still agree; this one fails, because a field on
  // BlogStateFacts that no producer supplies means every state on both surfaces is being derived
  // off that field's fallback and no one decided that.
  const missing = declared.filter((key) => !produced.has(key) && !exempt.has(key));
  assert.deepEqual(
    missing,
    [],
    "BlogStateFacts declares a fact neither producer supplies. Read it in both, or add it to the " +
      "Omit in ProducedStateFacts with the reason the record cannot answer it.",
  );

  // And the exemption has to still be real: a name removed from BlogStateFacts but left in the
  // Omit is an exemption for nothing, which quietly widens what the type stops checking.
  for (const key of exempt) {
    assert.ok(declared.includes(key), `ProducedStateFacts exempts '${key}', which BlogStateFacts no longer declares`);
  }
});

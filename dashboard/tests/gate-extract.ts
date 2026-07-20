/**
 * THE EXTRACTOR. It reads the SQL and the Python that actually refuse an admin write, and it
 * reduces each gating function to a normalized body a hash can be taken over.
 *
 * WHY THIS FILE EXISTS AT ALL. The defect it closes is not "the gate table has a wrong row": it
 * is that the gate table and the layers it describes were two independent statements of one rule,
 * with nothing but prose asserting they matched. Five rounds of patching moved a wrong row and
 * left the structure intact, and the guard test stayed green through every one of them because
 * the guard test restated the same hand model in a third place. A green invariant over a hand
 * model proves that the model agrees with itself and proves nothing else at all.
 *
 * So the mechanism is not a better model. It is an EXTRACTION: gate-contract.ts records, for each
 * refusal, the verbatim source line that performs it and a fingerprint of the whole enclosing
 * function, and the drift test re-derives both from the real files on every run. Change
 * admin_done_topic in SQL tomorrow and touch no TypeScript and the fingerprint moves, so the
 * dashboard test suite goes red naming the clauses that rested on it. That is the property the
 * previous rounds never had.
 *
 * THIS LIVES UNDER tests/ RATHER THAN src/ ON PURPOSE. It reads files from the repo working tree
 * with node:fs, which is a thing a browser bundle can never do and must never be asked to. The
 * contract that ships to the client carries only the recorded fingerprints, which are inert
 * strings; the code that checks them against reality runs in the test process alone.
 *
 * IT IS DELIBERATELY NOT A PARSER. A real SQL or Python parser would be a dependency, a build
 * step and a second thing to be wrong. What is needed here is far weaker: a stable, whitespace
 * and comment insensitive fingerprint that moves whenever the executable text moves. Comments and
 * docstrings are stripped precisely because this codebase writes very long ones and a prose edit
 * firing a red build teaches people to bump numbers without reading, which is the failure mode
 * that would kill this mechanism inside a month.
 *
 * THREE THINGS WERE ADDED AFTER A REVIEWER BROKE THE FIRST VERSION TWICE, and each closes a hole
 * the fingerprint alone could not see:
 *
 *   `refusalSites` enumerates every place a function says no, so the contract can be held to
 *   ACCOUNTING rather than to a hash. A fingerprint tells you a function moved; it cannot tell
 *   you a refusal was added, and the reviewer's first experiment was exactly that, in a function
 *   nobody had listed. Counting the sites turns "something changed" into "this many refusals
 *   exist, you have described this many, here is the one you have not".
 *
 *   `latestSqlDefinition` finds which migration CURRENTLY defines a SQL symbol. `create or
 *   replace function` means the last file to declare a name is the one the database runs, and
 *   the first version of this extractor read whichever file the contract named. It named
 *   009_admin_write_tier.sql for admin_done_topic, which migration 013 replaced wholesale, so
 *   the mechanism was fingerprinting DEAD TEXT and would have stayed green through any edit to
 *   the definition that actually executes.
 *
 *   `readSourceLines` is exported so the accounting test can report a real file line for a
 *   refusal it found and nobody recorded.
 *
 * A FOURTH THING WAS ADDED AFTER THE SAME REVIEWER BROKE IT A THIRD TIME, AND IT IS THE CASE OF
 * THE LETTERS. Both SQL lookups matched `create or replace function` in lower case with no `i`
 * flag, and SQL DDL is case insensitive: `CREATE OR REPLACE FUNCTION admin_save_blog_content(...)`
 * is the same statement to the database and was invisible here. The reviewer wrote exactly that
 * migration with every guard stripped out, and the full suite stayed green, because
 * `latestSqlDefinition` never saw the file and went on naming migration 010 as the live
 * definition. The contract then fingerprinted a body the database had stopped running, which is
 * the SAME defect `latestSqlDefinition` was written to close, arriving through the shift key.
 * Both patterns now carry `i` and tolerate whitespace runs between the keywords, because
 * `create   or replace  function` is also one statement.
 *
 * `create function` WITHOUT `or replace` IS A HARD ERROR AND NOT A MISS. A migration declaring a
 * listed symbol that way either fails to apply, because the name is taken, or it is the first
 * declaration and every earlier assumption about supersession is wrong. Reading it as "no
 * definition here" and moving on is the one answer that is certainly incorrect, so it throws.
 *
 * THE FIFTH THING IS `dependsOn`, AND IT ANSWERS "THE FINGERPRINT DOES NOT FOLLOW THE CALL". A
 * fingerprint covers the listed function's own body and nothing it calls, so every helper and
 * constant behind a gate was unpinned. Three mutations proved it: `MAX_IN_FLIGHT = 3` to 10 and
 * to 1, `_topic_status` forced to return "done", and `_with_client_since` inverted. Each left the
 * gate's own text byte identical, each left the suite green, and the `= 1` direction FAILS OPEN,
 * offering a comment control the engine refuses. `extractConstant` and `compositeFingerprint`
 * below let a source name what it rests on, so a dependency's body joins the hash it protects.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, from this file's own location, so the tests do not care about the cwd. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type GateSourceKind = "sql" | "python";

/** One extracted function: the raw slice, and the normalized text the fingerprint is taken over. */
export type ExtractedSymbol = {
  /** 1-indexed line in the file where the function's signature sits. */
  startLine: number;
  /** 1-indexed line of the last line of the body. */
  endLine: number;
  /** The verbatim slice, newline joined. Used for the per-clause condition lookups. */
  raw: string;
  /** Comments, docstrings, blank lines and indentation removed. What the hash is taken over. */
  normalized: string;
};

export function readSource(file: string): string[] {
  return readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
}

/**
 * The one pattern that recognises a SQL definition, built for a named symbol.
 *
 * IT LIVES HERE RATHER THAN BEING WRITTEN TWICE, which is the whole of why the casing hole
 * survived. `extractSymbol` and `latestSqlDefinition` each carried their own copy of this regex,
 * so the two agreed only by hand, and a fix applied to one would have left the other reading
 * upper case DDL as absent. One builder means one answer about what a definition looks like.
 *
 * `\s+` between the keywords rather than a single space, because SQL treats any whitespace run as
 * one separator and a reformatted migration is still the same statement. `i` because DDL keywords
 * and identifiers are case insensitive to the database, so a migration shouting its keywords
 * supersedes a lower case one and this file has to see it.
 */
function sqlDefinitionPattern(symbol: string, flags: string): RegExp {
  return new RegExp(`^create\\s+or\\s+replace\\s+function\\s+${escapeRe(symbol)}\\s*\\(`, flags);
}

/**
 * `create function` with no `or replace`, which is never a thing to pass over quietly.
 *
 * A migration declaring a symbol this contract lists gets exactly one honest reading, and it is
 * not "no definition in this file". Either the name is already taken and the migration cannot
 * apply, leaving the repo describing a database that refused it, or this is the first declaration
 * and every later `create or replace` is patching something this file has misattributed. Both are
 * conditions a person has to look at, so the extractor stops rather than choosing one.
 */
function sqlPlainCreatePattern(symbol: string): RegExp {
  return new RegExp(`^create\\s+function\\s+${escapeRe(symbol)}\\s*\\(`, "mi");
}

/**
 * Pull one function out of a file by name.
 *
 * SQL ends at the dollar quote terminator, which this codebase writes as a line of exactly `$$;`,
 * so the end is unambiguous and needs no brace counting. Python ends where the next top level
 * declaration or decorator begins, which is the only reliable boundary in an indentation language
 * without tokenizing it. Both throw rather than return null on a miss: a symbol that has been
 * RENAMED is the loudest possible drift, and silently reporting "no change" for it would be the
 * exact silence this whole mechanism exists to remove.
 */
export function extractSymbol(
  file: string,
  symbol: string,
  kind: GateSourceKind,
): ExtractedSymbol {
  const lines = readSource(file);
  const signature =
    kind === "sql"
      ? sqlDefinitionPattern(symbol, "i")
      : new RegExp(`^(async )?def ${escapeRe(symbol)}\\s*\\(`);

  const start = lines.findIndex((line) => signature.test(line));
  if (start === -1) {
    throw new Error(
      `gate contract: ${file} no longer defines ${symbol}. A renamed or deleted gate is drift of ` +
        `the loudest kind, so reconcile dashboard/src/lib/gate-contract.ts with the new shape ` +
        `rather than editing this message.`,
    );
  }

  let end = -1;
  if (kind === "sql") {
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "$$;") {
        end = i;
        break;
      }
    }
  } else {
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^(@|class |def |async def )/.test(lines[i])) {
        end = i - 1;
        break;
      }
    }
    if (end === -1) {
      end = lines.length - 1;
    }
  }
  if (end === -1) {
    throw new Error(`gate contract: could not find the end of ${symbol} in ${file}`);
  }

  const raw = lines.slice(start, end + 1).join("\n");
  return {
    startLine: start + 1,
    endLine: end + 1,
    raw,
    normalized: normalize(raw, kind),
  };
}

/**
 * Strip everything that is not executable text.
 *
 * The docstring removal is Python only and takes the FIRST triple quoted block after the
 * signature, which is the only place this codebase puts one on a route handler. A second block
 * further down would be a string literal doing real work, so it stays and correctly counts as
 * executable text.
 */
function normalize(raw: string, kind: GateSourceKind): string {
  let body = raw;
  if (kind === "python") {
    body = body.replace(/"""[\s\S]*?"""/, "");
  }
  const commentStart = kind === "sql" ? "--" : "#";
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith(commentStart))
    .map((line) => line.replace(/\s+/g, " "))
    .join("\n");
}

export function fingerprint(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

/**
 * A module level constant, extracted as its own assignment line.
 *
 * WHY A CONSTANT NEEDS EXTRACTING AT ALL. `blog_edit.MAX_IN_FLIGHT` is 3, the engine's comment
 * route refuses at it, and the contract's COMMENT_CAP clause compares against the same 3. Nothing
 * connected the two numbers: changing the Python to 10 left the route's own body byte identical,
 * because the body names the CONSTANT and not the value, so every fingerprint held and the suite
 * stayed green over a UI that now refuses at 3 while the engine allows up to 10. Changing it to 1
 * is the same silence pointing the other way and it FAILS OPEN: the page offers a comment control
 * for the second and third apply that the engine refuses outright.
 *
 * Only the assignment line is taken. A constant has no body, and the comment above it is prose
 * this file strips everywhere else for the reason the header gives.
 */
export function extractConstant(file: string, name: string): ExtractedSymbol {
  const lines = readSource(file);
  const assignment = new RegExp(`^${escapeRe(name)}\\s*(:[^=]+)?=`);
  const start = lines.findIndex((line) => assignment.test(line));
  if (start === -1) {
    throw new Error(
      `gate contract: ${file} no longer defines the constant ${name}. A gate resting on a value ` +
        `that has been renamed or deleted is drift of the loudest kind, so reconcile ` +
        `dashboard/src/lib/gate-contract.ts with the new shape rather than editing this message.`,
    );
  }
  const raw = lines[start];
  return {
    startLine: start + 1,
    endLine: start + 1,
    raw,
    normalized: raw.trim().replace(/\s+/g, " "),
  };
}

/**
 * One hash over a gate's own body plus every body it depends on.
 *
 * THE DEPENDENCY BODIES JOIN THE HASH RATHER THAN GETTING HASHES OF THEIR OWN, and the reason is
 * what a red build has to say. A separate hash per dependency would report "_topic_status moved"
 * with no word about which gate rested on it, and the person reading that message has to
 * reconstruct the link this table already knows. Joining them means the failure names the GATE,
 * and the gate's `what` sentence and its clause list come with it.
 *
 * AN EMPTY DEPENDENCY LIST HASHES EXACTLY AS THE BODY ALONE, which is deliberate and is what let
 * this land without re-recording a fingerprint for the twenty-odd sources that depend on nothing.
 * `[own].join("\n")` is `own`, so the composition is the identity where there is nothing to
 * compose.
 */
export function compositeFingerprint(own: string, dependencies: readonly string[]): string {
  return fingerprint([own, ...dependencies].join("\n"));
}

/**
 * One place a function says no.
 *
 * `text` is the refusal STATEMENT, not merely its first line, because the sentence that
 * identifies a Python refusal lives in the `detail=` argument several lines below the `raise`.
 * A window of following lines is joined so the contract can record a distinctive fragment of
 * that sentence and the accounting test can find it. The window is generous rather than exact
 * for the reason the header gives: a real parser is a dependency and a second thing to be wrong,
 * and everything downstream of this only needs to ask whether a recorded fragment is present.
 */
export type RefusalSite = {
  /** 1-indexed line in the file where the raise begins. */
  line: number;
  /** The raise statement and the lines that carry its message, joined with spaces. */
  text: string;
};

/** How many lines after a `raise` may still belong to it. Longer than any refusal in the tree. */
const REFUSAL_WINDOW = 14;

/**
 * Every refusal a function performs, in source order.
 *
 * WHAT COUNTS AS A REFUSAL, and the definition is deliberately narrow: a raise. SQL raises an
 * exception, Python raises HTTPException, EditError or PublishRefused, and each of those is a
 * hard no that reaches a caller. Everything else in these functions is control flow.
 *
 * WHAT THIS CANNOT SEE, stated here rather than discovered later: a refusal expressed as a
 * SENTINEL RETURN. blog_edit.mark_sent answers None for an approved article and for an open
 * client suggestion, and admin_send_blog_to_client refuses by updating zero rows and testing the
 * count. Neither is a raise, so neither appears here, and the contract carries clauses for both
 * with the sentinel named in the clause. The accounting test therefore proves that no RAISED
 * refusal is undescribed; it does not prove that no sentinel one is, and the fingerprint over
 * the whole body is what covers that half.
 */
export function refusalSites(extracted: ExtractedSymbol, kind: GateSourceKind): RefusalSite[] {
  const lines = extracted.raw.split("\n");
  const opener =
    kind === "sql"
      ? /^\s*raise\s+exception\b/
      : /^\s*raise\s+(HTTPException|EditError|PublishRefused)\s*\(/;

  // TWO PASSES, AND THE SECOND ONE IS WHY. A window that ran a fixed number of lines past its
  // raise could reach into the NEXT refusal's message, so a newly added raise sitting above an
  // existing one borrowed that one's recorded text and read as already described. The accounting
  // test then caught the addition only by its count, losing the message that names it. Each window
  // now stops where the next refusal begins, so a site's text is that site's and nobody else's.
  const openers = lines.reduce<number[]>((found, line, index) => {
    if (opener.test(line)) {
      found.push(index);
    }
    return found;
  }, []);

  return openers.map((index, position) => {
    const nextOpener = openers[position + 1] ?? lines.length;
    const end = Math.min(index + REFUSAL_WINDOW, nextOpener);
    const window = lines
      .slice(index, end)
      .map((entry) => entry.trim())
      .join(" ")
      .replace(/\s+/g, " ");
    return { line: extracted.startLine + index, text: window };
  });
}

/**
 * The migration that CURRENTLY defines a SQL symbol, which is the last one to declare it.
 *
 * THIS IS THE HOLE THAT MADE THE FIRST VERSION OF THIS MECHANISM PARTLY DECORATIVE. `create or
 * replace function` takes no patch, so a migration that changes one line restates the whole body
 * under the same name, and from that moment the earlier file is dead text that the database does
 * not run. Migration 013 did exactly that to admin_done_topic and migration 010 did it to
 * admin_save_blog_content, admin_add_comment, admin_dismiss_comment and admin_upload_blog. A
 * contract pinned to the earlier file fingerprints text nobody executes, and it would stay green
 * through any change to the definition that does.
 *
 * Files are ordered by their numeric prefix rather than by readdir order, because the numbers are
 * the apply order and the filesystem's order is not a fact about anything.
 *
 * THE MATCH IS CASE INSENSITIVE, and it was not, which made this function partly decorative in the
 * same way the thing it fixed was. A reviewer added a migration declaring
 * `CREATE OR REPLACE FUNCTION admin_save_blog_content(...)` in conventional upper case with every
 * guard removed, and this returned migration 010 as though nothing had happened. The database
 * would have been running the new body while the contract fingerprinted the old one and the
 * supersession test certified the pin. Lower casing the same file turned the suite red, so the
 * only thing standing between a stripped gate and a green build was the shift key.
 */
export function latestSqlDefinition(symbol: string): string {
  const dir = path.join(REPO_ROOT, "supabase/migrations");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

  const signature = sqlDefinitionPattern(symbol, "mi");
  const plainCreate = sqlPlainCreatePattern(symbol);
  let latest: string | null = null;
  for (const name of files) {
    const body = readFileSync(path.join(dir, name), "utf8");
    // Checked BEFORE the supersession match and never folded into it, because the two mean
    // opposite things. A `create or replace` is the ordinary way this repo restates a function; a
    // bare `create` on a name that already exists is a migration the database rejects, and
    // treating it as "this file does not define the symbol" would hide a repo that no longer
    // describes what ran.
    if (plainCreate.test(body)) {
      throw new Error(
        `gate contract: supabase/migrations/${name} declares ${symbol} with 'create function' ` +
          `rather than 'create or replace function'. Every other definition of a gated symbol in ` +
          `this repo is a replacement, so this either fails to apply against a database that ` +
          `already holds the name, or it is the first declaration and the supersession order ` +
          `this contract records is wrong. Read the migration and decide which, rather than ` +
          `relaxing this check.`,
      );
    }
    if (signature.test(body)) {
      latest = `supabase/migrations/${name}`;
    }
  }
  if (latest === null) {
    throw new Error(
      `gate contract: no migration defines ${symbol}. A renamed or deleted gate is drift of the ` +
        `loudest kind, so reconcile dashboard/src/lib/gate-contract.ts with the new shape rather ` +
        `than editing this message.`,
    );
  }
  return latest;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

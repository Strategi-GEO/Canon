import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId, validTopicSlug } from "@/lib/server/clients";
import { detail, failure, text } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

/** The engine's OUTPUT_WHITELIST, verbatim: anything else is a 404, which doubles as the
 * path-traversal guard for the name segment. */
const OUTPUT_WHITELIST = new Set([
  "blog.md",
  "eval.md",
  "dossier.md",
  "status.jsonl",
  "links-verified.txt",
]);

type EventRow = {
  ts: string | null;
  slug_reported: string | null;
  stage: string;
  event: string;
  iter: number;
  score: number | null;
  status: string;
  note: string;
};

/**
 * The engine's GET /api/clients/{slug}/output/{topic_slug}/{name}, record path only (hosted
 * mode never holds a live run, so the scratch branch does not exist here). Each name maps to
 * the column the runner commits it to, exactly as app.py _record_artifact reads them:
 * blog.md and eval.md from the latest blog_versions row, dossier.md and links-verified.txt
 * from the topics row, status.jsonl rebuilt line for line from status_events.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; topic: string; name: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, topic, name } = await params;
  try {
    if (!OUTPUT_WHITELIST.has(name)) {
      return detail(404, "not found");
    }
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    if (!validTopicSlug(topic)) {
      return detail(404, "not found");
    }
    const topics = await pg<{ id: string }[]>(
      user.token,
      `topics?select=id&client_id=eq.${cid}&slug=eq.${topic}&deleted_at=is.null`,
    );
    const tid = topics[0]?.id;
    if (tid === undefined) {
      return detail(404, "not found");
    }

    if (name === "dossier.md" || name === "links-verified.txt") {
      const column = name === "dossier.md" ? "dossier" : "links_verified";
      const rows = await pg<Record<string, string | null>[]>(
        user.token,
        `topics?select=${column}&id=eq.${tid}`,
      );
      const value = rows[0]?.[column] ?? null;
      return value === null ? detail(404, "not found") : text(value);
    }

    if (name === "blog.md" || name === "eval.md") {
      const rows = await pg<{ body: string | null; eval_body: string | null }[]>(
        user.token,
        `blog_versions?select=body,eval_body&topic_id=eq.${tid}&order=version_no.desc&limit=1`,
      );
      const row = rows[0];
      if (row === undefined) {
        return detail(404, "not found");
      }
      const value = name === "blog.md" ? row.body : row.eval_body;
      return value === null ? detail(404, "not found") : text(value);
    }

    // status.jsonl: one JSON object per line with exactly the keys .claude/status.py writes,
    // plus a trailing newline, as _record_artifact rebuilds it.
    const events = await pg<EventRow[]>(
      user.token,
      `status_events?select=ts,slug_reported,stage,event,iter,score,status,note` +
        `&topic_id=eq.${tid}&order=line_no.asc`,
    );
    if (events.length === 0) {
      return detail(404, "not found");
    }
    const lines = events.map((event) =>
      JSON.stringify({
        ts: event.ts,
        slug: event.slug_reported || topic,
        stage: event.stage,
        event: event.event,
        iter: event.iter,
        score: event.score,
        status: event.status,
        note: event.note,
      }),
    );
    return text(lines.join("\n") + "\n");
  } catch (cause) {
    return failure(cause);
  }
}

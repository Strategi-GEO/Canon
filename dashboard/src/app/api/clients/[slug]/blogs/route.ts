import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { byteCompare, clientId, ledgerSlugs } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { inList, pg } from "@/lib/server/postgrest";

type TopicRow = {
  id: string;
  slug: string;
  title: string | null;
  sent_to_client_at: string | null;
  client_approved_at: string | null;
};
type CommentRow = {
  topic_id: string;
  author: string;
  state: string;
};
type VersionRow = {
  topic_id: string;
  h1_title: string | null;
  committed_at: string;
  version_no: number;
  /** Null on a version no evaluator ever scored, which is half of what marks an upload. */
  score: number | null;
};
type RollupRow = {
  topic_id: string;
  status: string;
  score: number | null;
  iterations: number;
  event_count: number;
};

/**
 * The engine's GET /api/clients/{slug}/blogs, SETTLED data only: hosted mode has no live
 * runs, so the scratch overlay in app.py _blog_history never applies and the record answers
 * everything. Topics joined to their latest committed version, the status fold from the
 * topic_rollup view (verified against the engine's own summariser), titles and dates
 * preferring the ledger exactly as the engine prefers them.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;
  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }

    const [topics, versions, led, roadmapRows, comments] = await Promise.all([
      pg<TopicRow[]>(
        user.token,
        `topics?select=id,slug,title,sent_to_client_at,client_approved_at` +
          `&client_id=eq.${cid}&deleted_at=is.null`,
      ),
      pg<VersionRow[]>(
        user.token,
        // score rides along for the `uploaded` inference below. eval_body deliberately does
        // NOT: it is the whole evaluator report, on every version of every topic, and this
        // read already pulls them all to pick the latest per topic.
        `blog_versions?select=topic_id,h1_title,committed_at,version_no,score` +
          `&client_id=eq.${cid}&order=topic_id.asc,version_no.desc`,
      ),
      // The RAW ledger, exactly as _blog_history reads it: `shipped` is "ever recorded",
      // not "still live".
      ledgerSlugs(user.token, cid),
      pg<{ row_index: number; topic_slug: string | null }[]>(
        user.token,
        `roadmap_rows?select=row_index,topic_slug&client_id=eq.${cid}&order=row_index.asc`,
      ),
      // ONE brand-wide read folded to per-topic counts below, mirroring the engine's
      // _blog_history: one grouped count, never an N+1 per topic.
      pg<CommentRow[]>(
        user.token,
        `blog_comments?select=topic_id,author,state&client_id=eq.${cid}`,
      ),
    ]);

    // Latest version per topic: rows arrive version_no.desc within each topic, first wins.
    const latest = new Map<string, VersionRow>();
    for (const version of versions) {
      if (!latest.has(version.topic_id)) {
        latest.set(version.topic_id, version);
      }
    }

    // roadmap.index_by_slug: a dict comprehension in index order, so duplicate slugs
    // collapse and the LAST row wins. Empty slugs are skipped.
    const rowIndex = new Map<string, number>();
    for (const row of roadmapRows) {
      if (row.topic_slug !== null && row.topic_slug !== "") {
        rowIndex.set(row.topic_slug, row.row_index);
      }
    }

    // changes_requested, exactly as the engine's sent_state counts it: CLIENT-authored
    // suggestions still open or mid-apply. applying counts because a resolve in flight is
    // not resolved yet, and dropping it would flip the admin chip off a beat early, then
    // back on if the apply fails. resolved/failed/dismissed rows are settled or the
    // team's to retry, so they never gate a re-send.
    const openByTopic = new Map<string, number>();
    for (const comment of comments) {
      if (
        comment.author === "client" &&
        (comment.state === "open" || comment.state === "applying")
      ) {
        openByTopic.set(comment.topic_id, (openByTopic.get(comment.topic_id) ?? 0) + 1);
      }
    }

    const withVersions = topics.filter((topic) => latest.has(topic.id));
    const rollups = new Map<string, RollupRow>();
    if (withVersions.length > 0) {
      const rows = await pg<RollupRow[]>(
        user.token,
        `topic_rollup?select=topic_id,status,score,iterations,event_count` +
          `&topic_id=${inList(withVersions.map((topic) => topic.id))}`,
      );
      for (const row of rows) {
        rollups.set(row.topic_id, row);
      }
    }

    const blogs = withVersions.map((topic) => {
      const version = latest.get(topic.id) as VersionRow;
      const rollup = rollups.get(topic.id);
      // A topic with zero status events is what the engine reports as "unknown" with null
      // score and iterations; topic_rollup's 'running' default only applies once at least
      // one event exists, which event_count distinguishes.
      const folded =
        rollup !== undefined && rollup.event_count > 0
          ? { status: rollup.status, score: rollup.score, iterations: rollup.iterations }
          : { status: "unknown", score: null, iterations: null };
      const entry = led.get(topic.slug);
      return {
        topic: entry?.topic || version.h1_title || topic.title || topic.slug,
        topic_slug: topic.slug,
        created: entry?.generated_at || version.committed_at,
        score: folded.score,
        status: folded.status,
        iterations: folded.iterations,
        shipped: entry !== undefined,
        // The engine's inference, character for character: done, with no score on the
        // latest version, means no evaluator ever saw it, and an upload is the only door
        // into done that no evaluator opened. See _blog_history in server/app.py for why
        // both halves are needed and why eval_body is not a third condition.
        uploaded: folded.status === "done" && version.score === null,
        roadmap_index: rowIndex.get(topic.slug) ?? null,
        sent_to_client: topic.sent_to_client_at,
        client_approved: topic.client_approved_at,
        changes_requested: openByTopic.get(topic.id) ?? 0,
      };
    });

    // Newest first, compared as ISO strings exactly like the engine's sort key.
    blogs.sort((a, b) => byteCompare(b.created, a.created));
    return json({ blogs });
  } catch (cause) {
    return failure(cause);
  }
}

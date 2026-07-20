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
  published_at: string | null;
};
type CommentRow = {
  topic_id: string;
  author: string;
  state: string;
  /** Needed for the ROUND, which compares against the topic's send stamp. See the fold below. */
  created_at: string;
};
type VersionRow = {
  topic_id: string;
  h1_title: string | null;
  committed_at: string;
  version_no: number;
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
        // published_at and NOT cms_status, deliberately. 012 granted only the timestamp on
        // the base table: this route serves non-admin users too, so it cannot read
        // admin_topics, and cms_status stays off the client-readable column set until a
        // surface actually needs it. The cost is a known asymmetry, stated here rather than
        // discovered later: the local build can tell "live in the CMS" from "still a draft"
        // and the hosted build shows only that a push happened. Publishing runs on the local
        // engine, so the operator who needs that distinction is standing in front of it.
        `topics?select=id,slug,title,sent_to_client_at,client_approved_at,published_at` +
          `&client_id=eq.${cid}&deleted_at=is.null`,
      ),
      pg<VersionRow[]>(
        user.token,
        // NO score in this select, deliberately. Migration 003 revoked it from `authenticated`
        // along with eval_body, so asking the base table for it makes PostgREST refuse the
        // WHOLE request and this route answers 502 for every caller. The score comes from
        // admin_topic_rollup below, which is the same number by a different road: the fold
        // reads it off status_events, and sync.commit_topic copies that fold onto the version.
        `blog_versions?select=topic_id,h1_title,committed_at,version_no` +
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
      //
      // `parent_id=is.null` IS THE MIRROR, and this route was the one of four counters that
      // lacked it: blog_edit.sent_state, app.py _blog_history and portal-data.ts all filter it.
      // A reply is someone talking about a change rather than asking for one, and the
      // blog_comments_reply_open constraint pins replies at state 'open' forever, so counting
      // one made "thanks, this reads well" a permanent change request: it blocked the re-send
      // for good and left the admin holding edit rights during the client's review.
      pg<CommentRow[]>(
        user.token,
        `blog_comments?select=topic_id,author,state,created_at&client_id=eq.${cid}&parent_id=is.null`,
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

    // THE ROUND, mirroring the engine's _blog_history: has the client asked for anything SINCE
    // the last send. A different question from the count above, and the one that decides the
    // STATE. It reads no comment state at all, so resolving, dismissing and a failed apply all
    // leave the round standing, and only a re-send moving sent_to_client_at forward closes it.
    //
    // Keying the state off the open COUNT is what dead-ended the loop: resolving the last
    // suggestion returned the article to client_review, where the admin has no Send button, so
    // the fix they had just made could never be delivered and the client could approve the
    // stale bytes they were still pinned to.
    const sentAt = new Map(topics.map((t) => [t.id, t.sent_to_client_at]));
    const roundOpen = new Set<string>();
    for (const comment of comments) {
      const sent = sentAt.get(comment.topic_id);
      if (comment.author === "client" && sent && comment.created_at > sent) {
        roundOpen.add(comment.topic_id);
      }
    }

    const withVersions = topics.filter((topic) => latest.has(topic.id));
    const rollups = new Map<string, RollupRow>();
    if (withVersions.length > 0) {
      // admin_topic_rollup, not topic_rollup: 003 revoked the plain view from `authenticated`
      // because it re-exposes score and iterations, so reading it here answered 502 for every
      // caller. The admin view is the same fold behind auth_is_admin(), and it answers zero
      // rows rather than an error for anyone else, which the event_count branch below already
      // treats as "unknown".
      const rows = await pg<RollupRow[]>(
        user.token,
        `admin_topic_rollup?select=topic_id,status,score,iterations,event_count` +
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
        // The engine's inference: done, with no score, means no evaluator ever saw it, and an
        // upload is the only door into done that no evaluator opened. Read off the SAME fold
        // that produced `score` above rather than a second query against blog_versions.score,
        // which is the column 003 revoked. Both halves are load bearing: `done` alone catches
        // a stopped run, a null score alone catches one mid-flight.
        //
        // A non-admin gets no rollup rows, so folded.status is "unknown" and this is false.
        // That is the honest answer for a caller who cannot see scores at all: unknown, not
        // uploaded.
        uploaded: folded.status === "done" && folded.score === null,
        // The optimistic lock the hosted editor sends back. See the engine's _blog_history.
        version_no: version.version_no,
        roadmap_index: rowIndex.get(topic.slug) ?? null,
        sent_to_client: topic.sent_to_client_at,
        client_approved: topic.client_approved_at,
        changes_requested: openByTopic.get(topic.id) ?? 0,
        change_round_open: roundOpen.has(topic.id),
        // Null is "no record of a push", never "not published": nothing recorded a publish
        // before 012. cms_status is always null on this build, see the select above.
        published: topic.published_at,
        cms_status: null,
      };
    });

    // Newest first, compared as ISO strings exactly like the engine's sort key.
    blogs.sort((a, b) => byteCompare(b.created, a.created));
    return json({ blogs });
  } catch (cause) {
    return failure(cause);
  }
}

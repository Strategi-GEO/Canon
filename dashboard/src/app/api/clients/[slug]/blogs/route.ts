import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { byteCompare, clientId, ledgerSlugs } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { inList, pg } from "@/lib/server/postgrest";
// TYPE ONLY, so nothing of the portal's module reaches this route's runtime. The type is defined
// beside the OTHER producer rather than duplicated here on purpose: a shared shape kept in two
// places is the same promise-instead-of-mechanism that let these two fact sets drift twice.
import type { ProducedStateFacts } from "@/lib/server/portal-data";

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
/**
 * The evaluator's questions, parents only. `blog_version_id` IS the round identity: the current
 * form is every parent sharing the NEWEST note's anchor, exactly as portal-data.ts folds it and
 * as client_answers._PENDING_SQL selects it. Migration 003 grants id, topic_id, blog_version_id,
 * parent_id, author and created_at on this table to `authenticated`, so this select is inside the
 * grant; asked_score is NOT granted and must never join it, because an ungranted column makes
 * PostgREST refuse the WHOLE request and this route would answer 502 for every caller.
 */
type NoteRow = { id: string; topic_id: string; blog_version_id: string; created_at: string };
/** A reply, which is a note WITH a parent. Its created_at is the stamp the fact reports. */
type ReplyRow = { parent_id: string; created_at: string };
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

    const [topics, versions, led, roadmapRows, comments, notes, replies] = await Promise.all([
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
      // THE ANSWERS-SUBMITTED PAIR, two brand-wide reads folded per topic below, never a probe
      // per topic. Ordered created_at.desc so the first note of any topic is the newest, which is
      // how the fold names the current round without a second query. Same shape and same order as
      // portal-data.ts's own notes read, deliberately: two surfaces answering one field must not
      // use two definitions of which round is current.
      pg<NoteRow[]>(
        user.token,
        `review_notes?select=id,topic_id,blog_version_id,created_at&client_id=eq.${cid}` +
          `&author=eq.evaluator&parent_id=is.null&order=created_at.desc`,
      ),
      // `author=eq.client` on the REPLIES is load-bearing, not tidiness, and the reason is the
      // QUESTION being asked rather than the surface asking it. THREE different questions get
      // asked of these rows and only one of them is client scoped:
      //
      //   dispatch      is a revise owed? client_answers._PENDING_SQL, author agnostic: an
      //                 operator-answered form whose revise crashed owes the same rerun.
      //   is it spent   may this form still be submitted? portal_submit_answers, the engine's
      //                 describe_questions, blogs/[topic]/questions/route.ts and portal-data.ts's
      //                 `formSpent`, all author agnostic: any reply spends the form, and an
      //                 operator answer already dispatched its revise at submit time.
      //   visibility    has the CLIENT acted? THIS read, and portal-data.ts's `answered`, both
      //                 client scoped, because `answers_submitted` widens what a client sees and
      //                 portal-data.ts records what an unfiltered read cost there, an
      //                 internal_review article surfacing in a client's portal captioned as their
      //                 own answers.
      //
      // The third one is this field, so the filter stays. Reading the split as the binary
      // "dispatch versus visibility" is what let the spent question inherit a visibility filter in
      // portal-data.ts, where it offered a client a form portal_submit_answers refuses on every
      // submit, so the middle row is named here rather than left to be re-derived.
      //
      // This route emits NO spent fact and needs none: it carries no answer form. The admin's
      // answer door is blog-stage.tsx's canAnswer, and on this build HOSTED_READONLY closes it,
      // because no hosted answers or revise route exists to serve it.
      pg<ReplyRow[]>(
        user.token,
        `review_notes?select=parent_id,created_at&client_id=eq.${cid}` +
          `&parent_id=not.is.null&author=eq.client`,
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
    // comments_pending, the HUMAN-facing count: the same fold plus `failed`, mirroring the
    // engine's _blog_history and portal-data.ts's client count. A failed apply is the team's
    // retry, so to both humans that comment is simply not yet addressed; the state tags split
    // "Changes requested" from "With client" on THIS count, never on the send-gate one, or a
    // failed apply would read resolved to the admin while still pending to the client.
    const pendingByTopic = new Map<string, number>();
    for (const comment of comments) {
      if (comment.author !== "client") {
        continue;
      }
      if (comment.state === "open" || comment.state === "applying") {
        openByTopic.set(comment.topic_id, (openByTopic.get(comment.topic_id) ?? 0) + 1);
      }
      if (comment.state === "open" || comment.state === "applying" || comment.state === "failed") {
        pendingByTopic.set(comment.topic_id, (pendingByTopic.get(comment.topic_id) ?? 0) + 1);
      }
    }

    // THE ROUND, mirroring the engine's _blog_history: has the client asked for anything SINCE
    // the last send. A different question from the count above, and the one that decides the
    // STATE. It reads no comment state at all, so resolving, dismissing and a failed apply all
    // leave the round standing, and only a re-send moving sent_to_client_at forward closes it.
    //
    // THERE IS A SECOND FOLD OF THIS EXACT FACT, in lib/server/portal-data.ts, over rows the
    // portal read has already scoped to author=client and parent_id=is.null. The two must stay
    // the same fold: the portal shipped without this fact at all, fell back to the count, and
    // derived client_review where this route derived changes_requested from an identical record.
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

    // ANSWERS SUBMITTED: has the client fully answered the form standing on this blog RIGHT NOW.
    // blogState() derives a state from it so an article does not vanish from under a client the
    // instant they press submit. Between the submit and the rerun's terminal line the topic still
    // folds to needs_review, and after a clean rerun it folds to internal_review, which is not
    // theirs to see; without this fact the card they just acted on disappears with no receipt.
    //
    // SCOPED TO THE CURRENT FORM AND NOTHING ELSE. review_notes keeps answered rounds forever, so
    // "this topic has any answered question" would be true from the first submit onward: the blog
    // would pin here, internal_review would be masked, client_review would be unreachable, and the
    // article would never ship. A new round of questions carries a new anchor and no replies, so
    // the fact clears itself rather than needing an expiry rule that can be got wrong.
    const replyAt = new Map<string, string>();
    for (const reply of replies) {
      // One reply per question by construction; keep the newest defensively, as portal-data.ts does.
      const seen = replyAt.get(reply.parent_id);
      if (seen === undefined || reply.created_at > seen) {
        replyAt.set(reply.parent_id, reply.created_at);
      }
    }
    const formByTopic = new Map<string, NoteRow[]>();
    for (const note of notes) {
      const list = formByTopic.get(note.topic_id) ?? [];
      list.push(note);
      formByTopic.set(note.topic_id, list);
    }
    const answeredAt = new Map<string, string>();
    for (const [topicId, topicNotes] of formByTopic) {
      // Notes arrive created_at.desc, so the first one names the newest round.
      const formVersionId = topicNotes[0].blog_version_id;
      const form = topicNotes.filter((note) => note.blog_version_id === formVersionId);
      // Fully answered means EVERY question of THIS round has a reply. One unanswered question
      // leaves the form open, and an open form is has_questions, never answers_submitted.
      const stamps = form.map((note) => replyAt.get(note.id));
      if (stamps.every((stamp) => stamp !== undefined)) {
        // The newest reply within the form, so the stamp dates the moment the client finished.
        answeredAt.set(topicId, (stamps as string[]).reduce((a, b) => (a > b ? a : b)));
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

      // THE STATE FACTS, LIFTED OUT OF THE WIRE OBJECT AND TYPED, because these seven keys are a
      // contract with the other producer and the rest of the object is not. ProducedStateFacts
      // makes every key mandatory, so this literal and portal-data.ts's must carry the same set or
      // one of them stops compiling. It has drifted twice, both times by a key living here and not
      // there, and both times the portal silently took a blogState fallback this route never took.
      // Spread into the payload below so the wire shape is unchanged.
      const stateFacts: ProducedStateFacts = {
        status: folded.status,
        sent_to_client: topic.sent_to_client_at,
        client_approved: topic.client_approved_at,
        changes_requested: openByTopic.get(topic.id) ?? 0,
        change_round_open: roundOpen.has(topic.id),
        // An ISO stamp rather than a boolean, matching the engine's field and every other
        // human-act date here, so a card can show the receipt without a second call.
        answers_submitted: answeredAt.get(topic.id) ?? null,
        // Null is "no record of a push", never "not published": nothing recorded a publish
        // before 012. cms_status is always null on this build, see the select above.
        published: topic.published_at,
      };

      return {
        // topics.title FIRST: an operator rename (POST .../blogs/{topic}/title) is the
        // top-precedence label and outranks the ledger topic and the H1, matching the engine's
        // _blog_history override. Null for an un-renamed blog, so this falls through unchanged.
        topic: topic.title || entry?.topic || version.h1_title || topic.slug,
        topic_slug: topic.slug,
        created: entry?.generated_at || version.committed_at,
        score: folded.score,
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
        // THE SEVEN STATE FACTS, built and typed above. They land here rather than being written
        // out inline so that one type governs both producers of this fact set.
        ...stateFacts,
        // NOT a state fact: blogState never reads it. It is the display count the
        // changes_requested tag splits on, see BlogSummary's field doc.
        comments_pending: pendingByTopic.get(topic.id) ?? 0,
        cms_status: null,
        // `live` IS DELIBERATELY ABSENT FROM THIS OBJECT, and it is the one fact the engine's
        // twin emits that neither of this app's two producers does. ProducedStateFacts omits it
        // for both of them at once, with the shared half of the reason attached to the type;
        // repeated here is the half specific to this route. server/app.py _blog_history sets it
        // from runner.RUNS, an in-memory registry of the runs that uvicorn process owns right now.
        // Nothing equivalent is reachable from here: there is no liveness table in the schema,
        // migration 009 states that in its own header and names topic_rollup.status as the only
        // DB-visible stand-in, and this route reads the record over PostgREST and nothing else.
        // Emitting `live: false` would be worse than omitting it, because false is an assertion
        // this build cannot make: a teammate's local engine can own this topic at this moment
        // and no query here can tell.
        //
        // WHAT THE ABSENCE COSTS, written out so the next reader does not have to derive it.
        // blogState reads `facts.live ?? facts.status === "running"`, so on this build the
        // status fallback carries the whole weight, and that fallback CANNOT FIRE FOR A LIVE RUN
        // here. status_events reach the record only through sync.commit_topic, every runner.py
        // caller schedules that strictly after the terminal line, and sync.py's reconcile sweep
        // skips any topic a live run holds. So a topic in its first run has zero committed events
        // and folds to "unknown" through the event_count branch above, and a topic in a rerun
        // reports the PREVIOUS run's terminal status for the rerun's whole duration. The one road
        // by which 'running' reaches this route is the sweep committing a run that died without a
        // terminal line, which is a DEAD run: the fallback fires where it should not and stays
        // silent where it should speak.
        //
        // THE CONSEQUENCE IS A SAFETY ARGUMENT THAT DOES NOT HOLD ON THIS BUILD, so it is named
        // here rather than left to be rediscovered. lib/blog-state.ts grants edit, comments and
        // send in `answers_submitted` on the ground that `generating` is derived above every
        // stamp, so a live run can never be in flight in that state. That reasoning is sound
        // wherever `live` reaches blogState and unsound wherever it does not: an answer-driven
        // revise running on someone's local engine leaves this route reporting the previous
        // terminal status with the client's replies already in the record, which derives
        // `answers_submitted` and opens the full bench under a session that owns the draft.
        // HOSTED_READONLY suppresses those controls today, and it is a build-time NEXT_PUBLIC_
        // inline, so a mis-built deploy ships without the mask and nothing else stands behind it.
        // Closing this properly needs a liveness fact in the record: a table the engine writes on
        // register_run and clears when the run settles, granted to `authenticated`, joined here
        // and emitted as `live`. That is a new migration plus an engine writer, and neither is
        // this route's to add.
      };
    });

    // Newest first, compared as ISO strings exactly like the engine's sort key.
    blogs.sort((a, b) => byteCompare(b.created, a.created));
    return json({ blogs });
  } catch (cause) {
    return failure(cause);
  }
}

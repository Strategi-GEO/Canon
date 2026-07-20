import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId, validTopicSlug } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

type NoteRow = {
  id: string;
  blog_version_id: string;
  ref: string | null;
  area: string | null;
  body: string;
  why: string | null;
  asked_score: number | null;
  asked_iter: number | null;
  created_at: string;
};

/**
 * The engine's GET /api/clients/{slug}/blogs/{topic}/questions, mirroring
 * questions.describe_questions' record path: the current form is the latest asking round in
 * review_notes (every evaluator question sharing the newest round's blog_version_id), stale is
 * the form's version anchor OR its iteration having moved, answered means every question has an
 * operator child row, and blocking is current-and-unanswered, NEVER the score.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; topic: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, topic } = await params;
  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    if (!validTopicSlug(topic)) {
      return detail(404, `no blog '${topic}' for client '${slug}'`);
    }
    const topicRows = await pg<{ id: string }[]>(
      user.token,
      `topics?select=id&client_id=eq.${cid}&slug=eq.${topic}&deleted_at=is.null`,
    );
    const tid = topicRows[0]?.id;
    if (tid === undefined) {
      return detail(404, `no blog '${topic}' for client '${slug}'`);
    }

    const [notes, children, iterRows, versionRows] = await Promise.all([
      pg<NoteRow[]>(
        user.token,
        // admin_review_notes: asked_score is revoked from `authenticated` (003), and a query is
        // refused outright for filtering on or selecting a column it cannot read.
        `admin_review_notes?select=id,blog_version_id,ref,area,body,why,asked_score,asked_iter,created_at` +
          `&topic_id=eq.${tid}&author=eq.evaluator&parent_id=is.null&order=created_at.desc`,
      ),
      pg<{ parent_id: string; author: string; body: string }[]>(
        user.token,
        `admin_review_notes?select=parent_id,author,body&topic_id=eq.${tid}&parent_id=not.is.null`,
      ),
      // current_iteration: the high-water iter over status_events, the same fold
      // topic_rollup runs. Zero when no events exist.
      pg<{ iter: number }[]>(
        user.token,
        `status_events?select=iter&topic_id=eq.${tid}&order=iter.desc&limit=1`,
      ),
      // The topic's CURRENT version, which the staleness rule below needs and this route never
      // used to read. By version_no and never by committed_at: version_no carries
      // unique (topic_id, version_no) so that ordering is total, while two rows can share a
      // timestamp and leave "the current version" decided by whichever the planner returned.
      // Every other reader of the current draft in this codebase selects it exactly this way.
      // The base table rather than admin_blog_versions, because `id` and `version_no` are both
      // granted to `authenticated` on blog_versions (003) and neither one needs the definer
      // view: only the review_notes read above reaches for admin_ scope, and it does so for
      // asked_score alone.
      pg<{ id: string }[]>(
        user.token,
        `blog_versions?select=id&topic_id=eq.${tid}&order=version_no.desc&limit=1`,
      ),
    ]);

    if (notes.length === 0) {
      return detail(
        404,
        `no questions.json for ${slug}/${topic}: the evaluator asked nothing here`,
      );
    }

    // The form is the NEWEST round: every question sharing the most recently created row's
    // blog_version_id. Older rounds are history, not the form. Named for what it is, the FORM's
    // anchor, and not `latestVersionId`: the topic's own latest version is a different value
    // that arrives below, and calling this one "latest" is how a reader talks themselves into
    // believing the comparison has already been made.
    const formVersionId = notes[0].blog_version_id;
    const form = notes
      .filter((note) => note.blog_version_id === formVersionId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          (a.ref ?? "").localeCompare(b.ref ?? ""),
      );

    const answeredIds = new Set(children.map((child) => child.parent_id));
    const currentIter = iterRows[0]?.iter ?? 0;

    const formIter = form.find((row) => row.asked_iter !== null)?.asked_iter ?? null;
    const formScore = form.find((row) => row.asked_score !== null)?.asked_score ?? null;
    const asked = form.reduce<string | null>(
      (min, row) => (min === null || row.created_at < min ? row.created_at : min),
      null,
    );
    // stale is VERSION **OR** ITERATION, and this route is the FIFTH reader of that rule rather
    // than a place it gets a simpler one. The other four: questions.describe_questions in
    // server/questions.py, the portal fold in lib/server/portal-data.ts, _PENDING_SQL in
    // server/client_answers.py (which asks the complement, so it reads "version matches AND
    // iteration matches"), and portal_submit_answers as replaced by migration 014 and carried in
    // schema.sql. The v_review_notes view computes it too and is read by nothing, which schema.sql
    // says at the view itself, so it is named here only so the next person does not mistake it for
    // a sixth divergence.
    //
    // THIS READER WAS THE ONE LEFT ON THE OLD ITERATION-ONLY RULE, and the drift had a direction.
    // A form whose anchor has moved while its iteration landed on the same number read as
    // NOT stale here and stale everywhere else, so this route offered the admin questions panel a
    // form that portal_submit_answers then refuses as PORTAL:STALE at submit. The route was
    // already fetching the form's anchor and comparing it to nothing.
    //
    // The anchor leads because it is the stronger signal: review_notes.blog_version_id is NOT NULL
    // with a composite FK to blog_versions(id, topic_id), so it names the exact draft the questions
    // are about, where an iteration is a per-topic counter that only resembles an identity.
    //
    // THE ITERATION ARM STAYS BECAUSE A RESTORE COMMITS NO NEW VERSION: the stop-mid-revise path
    // puts the artifact set back byte for byte, adding no blog_versions row, so the anchor still
    // matches while the iteration has moved past it. Version-only would offer that form.
    //
    // The version arm fires only on a POSITIVE disagreement, matching migration 014's
    // `v_current_version is not null and ...` and describe_questions' same guard: a topic with no
    // readable current version leaves staleness to the iteration arm rather than hiding an
    // outstanding form behind a failed lookup. portal-data.ts reaches the same place by a
    // different route, skipping any topic with no committed version before it folds at all.
    // The form's own anchor needs no null guard here: blog_version_id is NOT NULL, so the empty
    // form portal-data.ts guards with `form.length > 0` is the case this route already answered
    // with a 404 above.
    const currentVersionId = versionRows[0]?.id ?? null;
    const versionMoved = currentVersionId !== null && formVersionId !== currentVersionId;
    const stale = versionMoved || formIter !== currentIter;
    const answered = form.every((row) => answeredIds.has(row.id));
    // Mirrors describe_questions: any client-authored reply on the form marks the whole
    // form client-answered, because that form owes its revise to the operator's Rerun.
    const formIds = new Set(form.map((row) => row.id));
    const authors = new Set(
      children.filter((child) => formIds.has(child.parent_id)).map((child) => child.author),
    );
    const answeredBy = !answered
      ? null
      : authors.has("client")
        ? "client"
        : authors.size > 0
          ? "operator"
          : null;
    // The answer texts travel with an answered form, mirroring describe_questions: the
    // operator reads them before deciding to spend a rerun on them.
    const answerByParent = new Map(
      children
        .filter((child) => formIds.has(child.parent_id))
        .map((child) => [child.parent_id, child.body]),
    );
    const answers = answered
      ? form.map((row) => ({ id: row.ref, answer: answerByParent.get(row.id) ?? "" }))
      : null;

    return json({
      slug: topic,
      asked,
      iter: formIter,
      score: formScore,
      questions: form.map((row) => ({
        id: row.ref,
        area: row.area,
        question: row.body,
        why: row.why ?? "",
      })),
      stale,
      blocking: !stale && !answered,
      answered,
      answered_by: answeredBy,
      answers,
    });
  } catch (cause) {
    return failure(cause);
  }
}

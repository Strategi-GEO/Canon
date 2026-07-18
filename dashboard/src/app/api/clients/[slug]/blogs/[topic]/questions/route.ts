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
 * review_notes (every evaluator question sharing the newest round's blog_version_id), stale
 * compares the form's iteration against the status_events high-water iter, answered means
 * every question has an operator child row, and blocking is current-and-unanswered, NEVER
 * the score.
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

    const [notes, children, iterRows] = await Promise.all([
      pg<NoteRow[]>(
        user.token,
        `review_notes?select=id,blog_version_id,ref,area,body,why,asked_score,asked_iter,created_at` +
          `&topic_id=eq.${tid}&author=eq.evaluator&parent_id=is.null&order=created_at.desc`,
      ),
      pg<{ parent_id: string; author: string; body: string }[]>(
        user.token,
        `review_notes?select=parent_id,author,body&topic_id=eq.${tid}&parent_id=not.is.null`,
      ),
      // current_iteration: the high-water iter over status_events, the same fold
      // topic_rollup runs. Zero when no events exist.
      pg<{ iter: number }[]>(
        user.token,
        `status_events?select=iter&topic_id=eq.${tid}&order=iter.desc&limit=1`,
      ),
    ]);

    if (notes.length === 0) {
      return detail(
        404,
        `no questions.json for ${slug}/${topic}: the evaluator asked nothing here`,
      );
    }

    // The form is the NEWEST round: every question sharing the most recently created row's
    // blog_version_id. Older rounds are history, not the form.
    const latestVersionId = notes[0].blog_version_id;
    const form = notes
      .filter((note) => note.blog_version_id === latestVersionId)
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
    const stale = formIter !== currentIter;
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

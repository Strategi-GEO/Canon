import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { brandRow, buildDetail } from "@/lib/server/portal-data";
import { pg } from "@/lib/server/postgrest";
import type { PortalBlogDetail, PortalComment, PortalReply } from "@/portal/types";

/**
 * One blog, in its client-visible shape for its current state. Out-of-scope and
 * nonexistent answer the same 404: a 404 that differed by scope would be an existence
 * oracle for other orgs' work.
 *
 * THE THREADS AND THE VERSION ARE READ HERE, not in buildDetail, and the reason is what
 * each read costs. buildDetail's fold runs for every topic of every brand on the overview,
 * where a card shows neither a conversation nor a version id; a thread is detail material
 * by definition, and the version exists to travel back on ONE button that only the detail
 * page holds. Reading them beside the fold keeps the list request the size it was.
 *
 * A client sees their OWN suggestions and every reply on them, and no operator comment of
 * its own: the comments an operator files are instructions to the team's own machinery,
 * written in the team's vocabulary, and they are not addressed to the client. Replies are
 * different, because a reply on a client's suggestion is the team answering that client.
 */

/** Exactly the columns this surface renders. author_email and applying_since are not
 *  granted to authenticated at all, and error and edits are the team's material: a failed
 *  apply is never the client's to read, so it is never selected. */
type ThreadRow = {
  id: string;
  parent_id: string | null;
  author: "operator" | "client";
  selected_text: string;
  instruction: string;
  state: PortalComment["state"];
  created_at: string;
};

type TopicRow = { id: string; sent_version_id: string | null };

/**
 * The client's suggestions with their conversations, oldest first, and the id of the
 * version on offer.
 *
 * Replies carry their text in `instruction` and nothing in selected_text, so a reply that
 * leaked into the top-level list would render as a suggestion about no passage at all. The
 * parent_id filter is what keeps them where they belong, and it is the same filter every
 * count and apply path on the engine side applies for the same reason.
 */
async function threadsFor(
  token: string,
  clientId: string,
  topicSlug: string,
): Promise<{ comments: PortalComment[]; version: string | null }> {
  const topics = await pg<TopicRow[]>(
    token,
    `topics?select=id,sent_version_id&client_id=eq.${clientId}` +
      `&slug=eq.${encodeURIComponent(topicSlug)}&deleted_at=is.null`,
  );
  const topic = topics[0];
  if (topic === undefined) {
    return { comments: [], version: null };
  }

  const rows = await pg<ThreadRow[]>(
    token,
    `blog_comments?select=id,parent_id,author,selected_text,instruction,state,created_at` +
      `&client_id=eq.${clientId}&topic_id=eq.${topic.id}&order=created_at.asc`,
  );

  const repliesByParent = new Map<string, PortalReply[]>();
  for (const row of rows) {
    if (row.parent_id === null) {
      continue;
    }
    const list = repliesByParent.get(row.parent_id) ?? [];
    // 'operator' becomes 'team' HERE, at the edge, so the record's word for the people who
    // wrote the article never reaches a client browser in any payload.
    list.push({
      id: row.id,
      author: row.author === "client" ? "you" : "team",
      body: row.instruction,
      created: row.created_at,
    });
    repliesByParent.set(row.parent_id, list);
  }

  const comments = rows
    .filter((row) => row.parent_id === null && row.author === "client")
    .map((row) => ({
      id: row.id,
      selected_text: row.selected_text,
      instruction: row.instruction,
      state: row.state,
      created: row.created_at,
      replies: repliesByParent.get(row.id) ?? [],
    }));

  return { comments, version: topic.sent_version_id };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ brand: string; topic: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand, topic } = await params;
  try {
    const blog = await buildDetail(user.token, brand, topic);
    if (blog === null) {
      return detail(404, `no blog '${topic}' for '${brand}'`);
    }
    // Only the released states have either. buildDetail already answers null for both on
    // the others, so the thread read is skipped rather than run and thrown away.
    if (blog.state !== "ready" && blog.state !== "approved") {
      return json({ ...blog, comments: null, version: null } satisfies PortalBlogDetail);
    }
    const scope = await brandRow(user.token, brand);
    if (scope === null) {
      return detail(404, `no blog '${topic}' for '${brand}'`);
    }
    const { comments, version } = await threadsFor(user.token, scope.client_id, topic);
    return json({ ...blog, comments, version } satisfies PortalBlogDetail);
  } catch (cause) {
    return failure(cause);
  }
}

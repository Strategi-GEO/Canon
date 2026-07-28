import { blogState, type BlogStateFacts } from "@/lib/blog-state";
import { adminFailedTag } from "@/lib/blog-score";
import { BlogStateTag } from "@/components/shell/blog-state-tag";

/**
 * ATTACH A BLOG, GET ITS TAG. The one entry point for a whole-blog tag when the caller holds the
 * blog entity rather than a resolved state: it runs blogState() over the wire fields, resolves the
 * failed-below-bar split from the score, and hands both to BlogStateTag. So no surface recomputes
 * the state, forgets the score (which is what made a 92 read "Failed" instead of "Below bar"), or
 * disagrees with the next surface about where a blog is.
 *
 * ADMIN-ONLY, and that is why it lives here and not beside BlogStateTag: it reads a score, and a
 * score never crosses the client wire, so it must not sit in a module the portal imports.
 * BlogStateTag stays the shared renderer; the client portal feeds it a server-resolved `state`
 * directly and passes no score. This wrapper is the admin side, where the entity IS the source.
 */
export function BlogTag({
  blog,
  audience = "admin",
  className,
}: {
  /** A blog entity carrying the wire fields blogState reads, plus its score and comment count.
   *  changes_requested is already on BlogStateFacts; only score and comments_pending are added. */
  blog: BlogStateFacts & {
    score?: number | null;
    comments_pending?: number | null;
  };
  audience?: "admin" | "client";
  className?: string;
}) {
  const state = blogState(blog);
  return (
    <BlogStateTag
      state={state}
      audience={audience}
      commentsPending={blog.comments_pending ?? blog.changes_requested ?? null}
      // Resolved here, not inside BlogStateTag, so the shared renderer never touches a score.
      failedTag={state === "failed" ? adminFailedTag(blog.score ?? null) : null}
      className={className}
    />
  );
}

import { StateTagChip } from "@/components/shell/state-tag-chip";
import {
  adminCommentsTag,
  adminTag,
  clientCommentsTag,
  clientTag,
  type BlogState,
  type StateTag,
} from "@/lib/blog-state";

/**
 * The tag that says where a blog is.
 *
 * ONE COMPONENT, TWO AUDIENCES, and the `audience` prop picks the vocabulary rather than the
 * caller assembling its own words. An admin sees "Internal review" and a client sees "In
 * progress" for the same record at the same instant, which is the point: they are different
 * sentences about ONE state, not two states that could drift apart.
 *
 * It replaces StatusBadge everywhere a whole blog is being described. StatusBadge remains for
 * the RUN status alone, which is a narrower fact: it answers "how did the loop end", while this
 * answers "where is this article and who owes the next act". The run status is an input to this,
 * not a synonym for it, and the difference is exactly what the old badge could not express: a
 * blog that is `done` might be with the team, with the client, approved or live, and every one
 * of those wants a different word.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. Every tone below pairs with a label that carries the same
 * meaning in words, so the tag reads correctly in greyscale and to anyone who cannot separate
 * the hues. The tooltip then names WHO OWES WHAT, which is the question a person scanning a list
 * is actually asking.
 */

export function BlogStateTag({
  state,
  audience,
  commentsPending,
  failedTag,
  className,
}: {
  state: BlogState;
  /** Which vocabulary to speak. Never inferred: the same component renders on both surfaces. */
  audience: "admin" | "client";
  /**
   * changes_requested only: how many of the client's comments are still unaddressed (open,
   * applying or failed). BOTH audiences split on it, each in its own vocabulary: the client
   * between "Pending comments" and "Comments resolved", the admin between "Changes requested"
   * and "With client". The labels live in blog-state.ts with every other label (labels never
   * leave that file); this prop only carries the one fact the state itself cannot. Omitting
   * it falls back to the plain state tag.
   */
  commentsPending?: number | null;
  /**
   * failed + admin only: the "Below bar" vs "Failed" split, already RESOLVED FROM THE SCORE by the
   * admin caller (BlogTag / lib/blog-score adminFailedTag). This renderer never sees the number:
   * a score does not cross the client wire, so the shared tag must not touch it. Clients never see
   * a failed article, so this is unused on that wire; omitting it falls back to the plain Failed
   * tag.
   */
  failedTag?: StateTag | null;
  className?: string;
}) {
  const pending =
    state === "changes_requested" && typeof commentsPending === "number" ? commentsPending : null;
  const tag =
    audience === "admin"
      ? state === "failed"
        ? failedTag ?? adminTag("failed")
        : pending !== null
          ? adminCommentsTag(pending)
          : adminTag(state)
      : pending !== null
        ? clientCommentsTag(pending)
        : clientTag(state);
  return <StateTagChip tag={tag} className={className} />;
}
// BlogTag (the admin wrapper that resolves state + score from a blog entity) moved to
// components/shell/blog-tag.tsx: it reads a score, which must not live in this client-bundle file.

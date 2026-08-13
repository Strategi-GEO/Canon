/**
 * WHICH MONTH A BLOG BELONGS TO, and nothing else.
 *
 * A month is a roadmap sheet plus the blogs written from it. The engine derives `month` from the
 * sheet whose row asked for the topic rather than storing it on the topic, which is sound only
 * because deleting a month's roadmap deletes that month's blogs with it (api_delete_roadmap): a
 * blog can never outlive the row that answers this question.
 *
 * ITS OWN FILE, AND THE REASON IS THE TEST RUNNER. The suites are TypeScript executed straight
 * through `node --test`, which strips types but resolves runtime imports itself and cannot follow
 * the `@/` alias. blogs-filter.ts imports blog-state at RUNTIME, so nothing in it is reachable
 * from a test; this module's only import is `import type`, which node erases outright, so the
 * rules below are directly checkable. Logic that decides what an operator sees belongs somewhere
 * a test can reach it.
 */

/**
 * ANY ROW THAT KNOWS ITS MONTH, which is deliberately structural rather than BlogSummary.
 *
 * The admin's summary and the portal's card are two different wire shapes carrying the same
 * answer to the same question, and the client's Blogs tab groups by month for the same reason the
 * admin's does. Typing these helpers to one of the two shapes would have forced the other to cast
 * or to keep a second copy of the rules below, and a second copy of "a null month files under the
 * latest" is exactly the drift this file exists to prevent.
 */
type Monthly = { month?: number | null };

/**
 * The month a blog files under for the Blogs tab's picker.
 *
 * A NULL MONTH FILES UNDER THE LATEST, which is the case a reader gets wrong. A blog with no
 * sheet row was made off-roadmap through /create/new or dropped in by hand, and generation is
 * locked to the latest month, so it was necessarily made while that month was current. Filing it
 * nowhere would hide an operator's own manual blog from every month there is.
 *
 * `latest` is null only for a brand with no roadmap at all, where there is no picker and every
 * blog shows regardless.
 */
export function monthOf(blog: Monthly, latest: number | null): number | null {
  return blog.month ?? latest;
}

/**
 * Whether a blog belongs in the month the picker is showing.
 *
 * A NULL `month` means EVERY month, not "blogs with no month": it is the absence of a filter, so
 * a caller with no picker (the client portal, anything predating this) keeps seeing everything.
 */
export function inMonth(
  blog: Monthly,
  month: number | null | undefined,
  latest: number | null,
): boolean {
  return month == null || monthOf(blog, latest) === month;
}

/**
 * topic_slug -> the month that blog files under, for resolving something that is NOT a blog.
 *
 * A LinkedIn post and a Medium article are repurposes of a blog, so they have no roadmap row of
 * their own and no month of their own: the roadmap planned the BLOG, and the post exists because
 * that blog did. Their month is therefore the source blog's, always, and this index is how a
 * caller holding posts rather than blogs asks for it.
 */
export function monthIndex(
  blogs: readonly (Monthly & { topic_slug: string })[],
  latest: number | null,
) {
  return new Map(blogs.map((blog) => [blog.topic_slug, monthOf(blog, latest)]));
}

/**
 * Whether a repurposed post belongs to the month on screen, resolved through its SOURCE blog.
 *
 * A post whose source blog is not in the index falls to `latest`, exactly as an off-roadmap blog
 * does. That is the honest answer rather than a defensive one: the blogs list is still loading, or
 * the source was deleted, and in both cases hiding the post from every month there is would lose
 * it entirely.
 */
export function postInMonth(
  sourceTopicSlug: string,
  index: ReadonlyMap<string, number | null>,
  month: number | null | undefined,
  latest: number | null,
): boolean {
  if (month == null) {
    return true;
  }
  const resolved = index.has(sourceTopicSlug) ? index.get(sourceTopicSlug) : latest;
  return (resolved ?? latest) === month;
}

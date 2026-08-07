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

import type { BlogSummary } from "@/types";

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
export function monthOf(blog: BlogSummary, latest: number | null): number | null {
  return blog.month ?? latest;
}

/**
 * Whether a blog belongs in the month the picker is showing.
 *
 * A NULL `month` means EVERY month, not "blogs with no month": it is the absence of a filter, so
 * a caller with no picker (the client portal, anything predating this) keeps seeing everything.
 */
export function inMonth(
  blog: BlogSummary,
  month: number | null | undefined,
  latest: number | null,
): boolean {
  return month == null || monthOf(blog, latest) === month;
}

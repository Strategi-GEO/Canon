"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  SORT_KEYS,
  STATUS_FILTERS,
  type SortDir,
  type SortKey,
  type StatusFilter,
} from "@/components/blogs/blogs-filter";

/**
 * The library's view state lives in the URL, not in useState.
 *
 * An open preview that dies on refresh is a bug: the operator's next move after reading a
 * blog is pasting the link to whoever has to approve it, and a drawer keyed on component
 * state cannot be sent to anyone. The same argument covers the filter, which an operator
 * sets once and expects to survive the refresh they hit to re-read the disk.
 *
 * Which history verb, and why it matters:
 *  - opening a preview PUSHES, so Back closes the drawer instead of leaving the library.
 *  - filters and search REPLACE. Typing seven characters must not cost seven Back presses
 *    to escape.
 */

export const DEFAULTS = {
  q: "",
  status: "all" as StatusFilter,
  sort: "created" as SortKey,
  dir: "desc" as SortDir,
};

const PARAM = { q: "q", status: "status", sort: "sort", dir: "dir", blog: "blog" } as const;

/** An unrecognised value in a hand-edited URL falls back rather than rendering an empty list
 *  the operator cannot explain. */
function one<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

export type LibraryUrl = {
  query: string;
  status: StatusFilter;
  sortKey: SortKey;
  sortDir: SortDir;
  /** The topic_slug named by ?blog, or null. Whether it EXISTS is the disk's answer, not ours. */
  previewSlug: string | null;
  setQuery: (value: string) => void;
  setStatus: (value: StatusFilter) => void;
  /** Both filters in ONE write. Calling setQuery then setStatus in the same tick would lose
   *  the first: each builds its next URL from the params of the render it was created in, so
   *  the second write starts from a snapshot that never saw the first. */
  clearFilters: () => void;
  setSort: (key: SortKey) => void;
  openPreview: (topicSlug: string) => void;
  closePreview: () => void;
};

export function useLibraryUrl(): LibraryUrl {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const query = params.get(PARAM.q) ?? DEFAULTS.q;
  const status = one(params.get(PARAM.status), STATUS_FILTERS, DEFAULTS.status);
  const sortKey = one(params.get(PARAM.sort), SORT_KEYS, DEFAULTS.sort);
  const sortDir = one(params.get(PARAM.dir), ["asc", "desc"] as const, DEFAULTS.dir);
  const previewSlug = params.get(PARAM.blog);

  // True only when THIS component pushed the open preview. A deep link arrives with ?blog
  // already set and nothing of ours on the stack, so closing it with back() would send the
  // operator to whatever page preceded the link, or off the site entirely.
  const pushedPreview = React.useRef(false);

  const write = React.useCallback(
    (mutate: (next: URLSearchParams) => void, method: "push" | "replace") => {
      const next = new URLSearchParams(params.toString());
      mutate(next);
      const qs = next.toString();
      // scroll: false, because every one of these keeps the operator on the same list. A jump
      // to the top on each keystroke would fight the person doing the typing.
      router[method](qs === "" ? pathname : `${pathname}?${qs}`, { scroll: false });
    },
    [params, pathname, router],
  );

  /** A param at its default is absent: the URL an operator copies should carry what they
   *  chose, not a transcript of every knob's resting position. */
  const set = React.useCallback(
    (key: string, value: string, fallback: string, method: "push" | "replace" = "replace") => {
      write((next) => {
        if (value === fallback) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }, method);
    },
    [write],
  );

  const setSort = React.useCallback(
    (key: SortKey) => {
      // Re-picking the active column flips direction, which is what every table an operator
      // has ever used does. A new column starts descending: newest, highest, most urgent.
      const dir: SortDir = key === sortKey && sortDir === "desc" ? "asc" : "desc";
      write((next) => {
        if (key === DEFAULTS.sort) {
          next.delete(PARAM.sort);
        } else {
          next.set(PARAM.sort, key);
        }
        if (dir === DEFAULTS.dir) {
          next.delete(PARAM.dir);
        } else {
          next.set(PARAM.dir, dir);
        }
      }, "replace");
    },
    [sortKey, sortDir, write],
  );

  const openPreview = React.useCallback(
    (topicSlug: string) => {
      pushedPreview.current = true;
      write((next) => next.set(PARAM.blog, topicSlug), "push");
    },
    [write],
  );

  const closePreview = React.useCallback(() => {
    if (pushedPreview.current) {
      pushedPreview.current = false;
      // Unwinds the exact entry the open pushed, so the address bar and the Back button agree.
      router.back();
      return;
    }
    write((next) => next.delete(PARAM.blog), "replace");
  }, [router, write]);

  return {
    query,
    status,
    sortKey,
    sortDir,
    previewSlug,
    setQuery: React.useCallback((value) => set(PARAM.q, value, DEFAULTS.q), [set]),
    setStatus: React.useCallback((value) => set(PARAM.status, value, DEFAULTS.status), [set]),
    clearFilters: React.useCallback(
      () =>
        write((next) => {
          next.delete(PARAM.q);
          next.delete(PARAM.status);
        }, "replace"),
      [write],
    ),
    setSort,
    openPreview,
    closePreview,
  };
}

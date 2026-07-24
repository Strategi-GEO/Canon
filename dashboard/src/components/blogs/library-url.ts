"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  SORT_KEYS,
  STATE_FILTERS,
  type SortDir,
  type SortKey,
  type StateFilter,
} from "@/components/blogs/blogs-filter";

/**
 * The library's view state lives in the URL, not in useState: an operator sets a filter
 * once and expects it to survive the refresh they hit to re-read the disk, and a filtered
 * list is a thing they paste to a teammate.
 *
 * Filters and search REPLACE history. Typing seven characters must not cost seven Back
 * presses to escape.
 *
 * ?blog= is LEGACY, read-only. The preview drawer that lived there is gone: a blog now has
 * its own page under /blogs/<topic>. The param is still read so every link that was ever
 * sent around redirects to that page instead of dying.
 */

export const DEFAULTS = {
  q: "",
  status: "all" as StateFilter,
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
  status: StateFilter;
  sortKey: SortKey;
  sortDir: SortDir;
  /** The topic_slug a LEGACY ?blog link names, or null. The library redirects it to the
   *  blog's own page; nothing writes this param any more. */
  previewSlug: string | null;
  setQuery: (value: string) => void;
  setStatus: (value: StateFilter) => void;
  /** Both filters in ONE write. Calling setQuery then setStatus in the same tick would lose
   *  the first: each builds its next URL from the params of the render it was created in, so
   *  the second write starts from a snapshot that never saw the first. */
  clearFilters: () => void;
  setSort: (key: SortKey) => void;
};

export function useLibraryUrl(): LibraryUrl {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const query = params.get(PARAM.q) ?? DEFAULTS.q;
  const status = one(params.get(PARAM.status), STATE_FILTERS, DEFAULTS.status);
  const sortKey = one(params.get(PARAM.sort), SORT_KEYS, DEFAULTS.sort);
  const sortDir = one(params.get(PARAM.dir), ["asc", "desc"] as const, DEFAULTS.dir);
  const previewSlug = params.get(PARAM.blog);

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
  };
}

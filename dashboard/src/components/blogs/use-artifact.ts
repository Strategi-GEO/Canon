"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { OutputFile } from "@/types";

export type LoadedArtifact = { text: string } | { error: ApiError };

/**
 * One artifact, fetched when `name` is non-null, re-fetched on reload().
 *
 * Nothing is cached across mounts. GET /blogs and this endpoint both read the engine's
 * truth (disk locally, the record hosted), and a cache would keep serving a preview of a
 * file the operator deleted in Finder thirty seconds ago. Re-reading on every open is the
 * behaviour, not an oversight.
 *
 * The settled result is stored WITH the request it answers. Switching artifacts then has
 * nothing to reset: a result whose key no longer matches is simply not this artifact's
 * result, so the read below returns undefined and the skeleton comes back on its own.
 * Clearing state from inside the effect instead would be a synchronous setState in an
 * effect body, which is a cascading render and which this project's lint rules reject on
 * sight.
 *
 * reload() exists for the blog stage: a save or an applied comment changes blog.md, and
 * the view must re-read what the engine now holds rather than what it held at mount.
 */
export function useArtifact(
  brandSlug: string,
  topicSlug: string,
  name: OutputFile | null,
): { loaded: LoadedArtifact | undefined; reload: () => void } {
  const [settled, setSettled] = React.useState<{
    key: string;
    loaded: LoadedArtifact;
  } | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const key = `${brandSlug}/${topicSlug}/${name}/${attempt}`;

  React.useEffect(() => {
    if (name === null) {
      return;
    }
    const controller = new AbortController();
    api.output(brandSlug, topicSlug, name, controller.signal).then(
      (text) => setSettled({ key, loaded: { text } }),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setSettled({
          key,
          loaded: {
            error: cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
          },
        });
      },
    );
    return () => controller.abort();
  }, [brandSlug, topicSlug, name, key]);

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);

  return { loaded: settled?.key === key ? settled.loaded : undefined, reload };
}

export const artifactText = (loaded: LoadedArtifact | undefined): string | null =>
  loaded && "text" in loaded ? loaded.text : null;

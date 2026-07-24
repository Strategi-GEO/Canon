"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Loader2, RotateCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { useRuns } from "@/lib/runs-context";
import { formatRelative } from "@/lib/format";
import { MarkdownView } from "@/components/blogs/markdown-view";
import type { RepurposeArtifact, RepurposeChannel } from "@/types";

/**
 * The review surface for one generated channel piece: it makes the output VISIBLE and copyable,
 * and nothing else. There is deliberately no send, no approve, and no score here. What happens to
 * the piece after review is not decided yet.
 *
 * LinkedIn is shown with whitespace preserved, because on LinkedIn the line breaks ARE the
 * structure and nothing renders as markdown. Medium is a structured article, so it renders
 * through the shared markdown view.
 */
export function ChannelReview(props: {
  orgSlug: string;
  brandSlug: string;
  channel: RepurposeChannel;
  topicSlug: string;
}) {
  const { orgSlug, brandSlug, channel, topicSlug } = props;
  const label = channel === "linkedin" ? "LinkedIn post" : "Medium article";
  const backHref = brandHref(orgSlug, brandSlug, `/${channel}`);

  const [loaded, setLoaded] = React.useState<{ art: RepurposeArtifact } | { error: ApiError } | null>(
    null,
  );
  const [title, setTitle] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const { runs } = useRuns();
  const live = React.useMemo(
    () =>
      runs.some(
        (r) =>
          r.kind === "repurpose" &&
          r.client === brandSlug &&
          r.live &&
          r.channel === channel &&
          r.topics.some((t) => t.source_topic_slug === topicSlug),
      ),
    [runs, brandSlug, channel, topicSlug],
  );

  const load = React.useCallback(
    (signal?: AbortSignal) =>
      api.repurposeArtifact(brandSlug, topicSlug, channel, signal).then(
        (art) => setLoaded({ art }),
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setLoaded({ error: cause instanceof ApiError ? cause : new ApiError(0, String(cause), null) });
        },
      ),
    [brandSlug, topicSlug, channel],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    // The blog's title, for the header. A miss falls back to the slug, so its failure is silent.
    api.blogs(brandSlug, controller.signal).then(
      (data) => setTitle(data.blogs.find((b) => b.topic_slug === topicSlug)?.topic ?? null),
      () => {},
    );
    return () => controller.abort();
  }, [load, brandSlug, topicSlug]);

  // When a live run for this piece finishes, re-read the artifact so the page flips from
  // Generating to the finished piece on its own.
  const prevLive = React.useRef(false);
  React.useEffect(() => {
    if (prevLive.current && !live) void load();
    prevLive.current = live;
  }, [live, load]);

  async function regenerate() {
    try {
      await api.repurpose(brandSlug, { topic_slug: topicSlug, channel });
    } catch {
      // The row-level tab owns start errors; here a failed regenerate just leaves the current
      // piece in place, and the run poll will not show a run that never registered.
    }
  }

  async function copy(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (no permission, insecure origin): nothing to do but leave the text on
      // screen for a manual select.
    }
  }

  const art = loaded && "art" in loaded ? loaded.art : null;
  const notGenerated = loaded !== null && "error" in loaded && loaded.error.status === 404;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to {channel === "linkedin" ? "LinkedIn" : "Medium"}
          </Link>
          <h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-foreground">
            {title ?? topicSlug}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {label}
            {art ? ` · generated ${formatRelative(art.generated_at)}` : null}
          </p>
        </div>

        {art ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void copy(art.content)}>
              {copied ? (
                <Check data-icon="inline-start" aria-hidden />
              ) : (
                <Copy data-icon="inline-start" aria-hidden />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            {!HOSTED_READONLY ? (
              <Button size="sm" variant="ghost" onClick={() => void regenerate()} disabled={live}>
                <RotateCw data-icon="inline-start" aria-hidden />
                Regenerate
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {loaded === null ? (
        <Skeleton className="h-96 w-full" />
      ) : live ? (
        <Card>
          <CardContent className="py-14 text-center">
            <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
            <p className="mt-3 text-sm font-medium text-foreground">Generating the {label}…</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              This runs on the local engine and appears here as soon as it lands. You can leave and
              come back.
            </p>
          </CardContent>
        </Card>
      ) : notGenerated ? (
        <Card>
          <CardContent className="py-14 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <Sparkles className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <p className="mt-3 text-sm font-medium text-foreground">No {label} generated yet</p>
            <p className="mx-auto mt-1 mb-4 max-w-md text-xs text-muted-foreground">
              Generate the {label} for this blog, then review it here.
            </p>
            {!HOSTED_READONLY ? (
              <Button size="sm" onClick={() => void regenerate()}>
                <Sparkles data-icon="inline-start" aria-hidden />
                Generate {label}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : loaded && "error" in loaded ? (
        <Card className="border-fail/25 bg-fail-bg">
          <CardContent className="py-8 text-center">
            <p className="text-sm font-medium text-fail">
              {loaded.error.isOffline ? "Cannot reach the engine" : "The engine refused the request"}
            </p>
            <p className="machine mx-auto mt-2 max-w-md text-xs wrap-break-word text-fail/80">
              {loaded.error.message}
            </p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : art ? (
        <Card>
          <CardContent className="p-6">
            {channel === "linkedin" ? (
              <p className="text-[0.9375rem] leading-[1.7] whitespace-pre-wrap text-foreground">
                {art.content}
              </p>
            ) : (
              <MarkdownView source={art.content} variant="article" />
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

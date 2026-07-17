"use client";

import * as React from "react";
import { Check, Copy, Download, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/shell/status-badge";
import { AnswerQuestions } from "@/components/blogs/answer-questions";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { PublishAction } from "@/components/blogs/publish-action";
import { extractScore } from "@/components/blogs/markdown";
import { countSources, countWords } from "@/components/blogs/metrics";
import { readTrail, type RunTrail } from "@/components/blogs/status-trail";
import { TRIGGER_ATTR } from "@/components/blogs/blogs-table";
import { isKnownStatus } from "@/components/blogs/blogs-filter";
import { formatAbsolute, formatCount, formatRelative } from "@/lib/format";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { TopicQuestions } from "@/lib/use-blog-questions";
import type { BlogSummary, OutputFile } from "@/types";

/** The three narrative artifacts. status.jsonl is read too, but as the run feed behind the
 *  header rather than as something to page through. links-verified.txt is a working file. */
const TABS: { name: OutputFile; label: string }[] = [
  { name: "blog.md", label: "blog.md" },
  { name: "eval.md", label: "eval.md" },
  { name: "dossier.md", label: "dossier.md" },
];

type Loaded = { text: string } | { error: ApiError };

/**
 * One artifact, fetched when `name` is non-null.
 *
 * Nothing is cached across opens. GET /blogs and this endpoint both read the DISK, and a
 * cache would keep serving a preview of a file the operator deleted in Finder thirty seconds
 * ago. Re-reading on every open is the behaviour, not an oversight.
 */
function useArtifact(
  brandSlug: string,
  topicSlug: string,
  name: OutputFile | null,
): Loaded | undefined {
  // The settled result is stored WITH the request it answers. Switching tabs then has nothing
  // to reset: a result whose key no longer matches is simply not this artifact's result, so
  // the read below returns undefined and the skeleton comes back on its own. Clearing state
  // from inside the effect instead would be a synchronous setState in an effect body, which
  // is a cascading render and which this project's lint rules reject on sight.
  const [settled, setSettled] = React.useState<{ key: string; loaded: Loaded } | null>(null);
  const key = `${brandSlug}/${topicSlug}/${name}`;

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

  return settled?.key === key ? settled.loaded : undefined;
}

const textOf = (loaded: Loaded | undefined): string | null =>
  loaded && "text" in loaded ? loaded.text : null;

export function PreviewDrawer({
  brandSlug,
  blog,
  demoMode,
  questions,
  onQuestionsSettled,
  onClose,
}: {
  brandSlug: string;
  /** The blog named by the URL, resolved against the disk listing. null closes the drawer. */
  blog: BlogSummary | null;
  /** The brand's demo flag, read only by the Post button. */
  demoMode: boolean;
  /**
   * This blog's questions, from the library's one read rather than a second fetch of the same
   * file. The library needs them for its row signal anyway, and two reads of one file is the
   * shape that lets a row and the drawer it opens disagree about whether a blog is waiting.
   * Undefined while that read is in flight.
   */
  questions: TopicQuestions | undefined;
  /** Re-reads the blogs and the questions: a submit files one, and a revise changes the score. */
  onQuestionsSettled: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={blog !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        // Radix traps focus and closes on Escape already. The explicit restore covers what
        // Radix cannot: this drawer is shared by every row and can be opened by a URL nobody
        // clicked, so it has no single trigger element to hand focus back to. The row is
        // found by slug, which survives both a deep link and a refresh.
        onCloseAutoFocus={(event) => {
          if (blog === null) {
            return;
          }
          const row = document.querySelector<HTMLElement>(
            `[${TRIGGER_ATTR}="${CSS.escape(blog.topic_slug)}"]`,
          );
          if (row) {
            event.preventDefault();
            row.focus();
          }
        }}
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-2xl lg:data-[side=right]:sm:max-w-3xl"
      >
        {/* Keyed by blog: opening a different row remounts the body, so the tab selection and
            the fetched text reset themselves. Clearing that state from an effect would render
            one blog's article under another blog's title for a frame first. */}
        {blog ? (
          <PreviewBody
            key={blog.topic_slug}
            brandSlug={brandSlug}
            blog={blog}
            demoMode={demoMode}
            questions={questions}
            onQuestionsSettled={onQuestionsSettled}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function PreviewBody({
  brandSlug,
  blog,
  demoMode,
  questions,
  onQuestionsSettled,
}: {
  brandSlug: string;
  blog: BlogSummary;
  demoMode: boolean;
  questions: TopicQuestions | undefined;
  onQuestionsSettled: () => void;
}) {
  const [tab, setTab] = React.useState<OutputFile>("blog.md");
  const topicSlug = blog.topic_slug;

  // blog.md loads regardless of the open tab: the word count and source count in the header
  // are measured from the draft itself, so they cannot wait for the operator to pick a tab.
  const article = useArtifact(brandSlug, topicSlug, "blog.md");
  const status = useArtifact(brandSlug, topicSlug, "status.jsonl");
  const other = useArtifact(brandSlug, topicSlug, tab === "blog.md" ? null : tab);

  const loaded = tab === "blog.md" ? article : other;
  const raw = textOf(loaded);
  const articleText = textOf(article);
  const statusText = textOf(status);

  const trail = React.useMemo<RunTrail | null>(
    () => (statusText === null ? null : readTrail(statusText)),
    [statusText],
  );

  return (
    <>
      <SheetHeader className="gap-0 border-b p-4 pr-14">
        <SheetTitle className="text-base leading-snug text-pretty">
          {/* Ahead of the title, because this is the drawer someone opens when a client says
              "change blog six" and the number is what confirms they opened the right one. It
              reads as part of the heading rather than a chip beside it: the row IS the blog's
              name here, the way a chapter number belongs to its chapter. */}
          {blog.roadmap_index !== null ? (
            <span className="machine mr-1.5 font-normal text-muted-foreground">
              {blog.roadmap_index + 1}.
            </span>
          ) : null}
          {blog.topic}
        </SheetTitle>
        <SheetDescription asChild>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {isKnownStatus(blog.status) ? <StatusBadge status={blog.status} /> : null}
            <ScoreTrail score={blog.score} trail={trail} />
            <Meta text={articleText} />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="machine cursor-default text-xs text-muted-foreground">
                  {formatRelative(blog.created)}
                </span>
              </TooltipTrigger>
              <TooltipContent className="machine">
                {formatAbsolute(blog.created)}
              </TooltipContent>
            </Tooltip>
          </div>
        </SheetDescription>
      </SheetHeader>

      {/* ONE strip owns the whole review conversation, including the engine's reason for
          holding this blog. It used to be two: a box demanding that a human confirm something,
          and, under it, the box that could answer. An operator reading the demand had no way to
          know the door was the box below it, and on a blog with no answerable question there was
          no door anywhere. A demand and the response to it belong in the same box, so the reason
          is handed to the panel that renders the response rather than rendered beside it. */}
      <AnswerQuestions
        brandSlug={brandSlug}
        topicSlug={topicSlug}
        blogScore={blog.score}
        entry={questions}
        review={
          blog.status === "needs_review"
            ? { note: trail?.terminalNote ?? null, pending: status === undefined }
            : null
        }
        onSettled={onQuestionsSettled}
      />

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as OutputFile)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <TabsList variant="line">
            {TABS.map((item) => (
              <TabsTrigger key={item.name} value={item.name} className="machine text-xs">
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex items-center gap-2">
            {/* Sits with copy and download because it is the same kind of act: taking the
                finished draft somewhere. Posting is confirmed and the engine refuses anything
                not shipped, so it is no more dangerous than the two beside it. */}
            <PublishAction
              brandSlug={brandSlug}
              topicSlug={topicSlug}
              topic={blog.topic}
              status={blog.status}
              demoMode={demoMode}
            />
            <Artifacts raw={raw} tab={tab} topicSlug={topicSlug} />
          </div>
        </div>

        {TABS.map((item) => (
          <TabsContent key={item.name} value={item.name} className="min-h-0">
            <ScrollArea className="h-[calc(100svh-11.5rem)]">
              <div className="px-4 py-6 sm:px-6">
                {item.name === tab ? <Artifact name={item.name} loaded={loaded} /> : null}
                {/* The real path on disk, so an operator can open the file in Finder. */}
                <p className="machine mx-auto mt-10 max-w-[68ch] border-t pt-3 text-xs wrap-anywhere text-muted-foreground">
                  outputs/{brandSlug}/{topicSlug}/{item.name}
                </p>
              </div>
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

/**
 * The score, and how it got there. GET /blogs reports only the final number, so "96" alone
 * cannot tell an operator whether the draft landed there or climbed from 88 over four
 * iterations. The trail is read from the engine's own eval lines; a run with one iteration
 * has nothing to show and shows nothing.
 */
function ScoreTrail({ score, trail }: { score: number | null; trail: RunTrail | null }) {
  if (typeof score !== "number") {
    // No eval ever ran. A zero or a dash here would be a number the engine never produced.
    return <span className="text-xs text-muted-foreground">no score</span>;
  }
  const scores = trail?.scores ?? [];
  const shipped = score >= 95;
  return (
    <span className="machine inline-flex items-center gap-1.5 text-xs">
      {scores.length > 1 ? (
        <span className="text-muted-foreground">
          {scores
            .slice(0, -1)
            .map((value) => `${value} → `)
            .join("")}
        </span>
      ) : null}
      <span className={cn("font-medium", shipped ? "text-ship" : "text-foreground")}>
        {score}
      </span>
      <span className="text-muted-foreground">/100</span>
    </span>
  );
}

/** Measured from the draft, and only once the draft is actually here. */
function Meta({ text }: { text: string | null }) {
  if (text === null) {
    return null;
  }
  const words = countWords(text);
  const sources = countSources(text);
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="machine cursor-default text-xs text-muted-foreground">
            {formatCount(words)} words
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Counted the way the engine&apos;s word-count gate counts, with link syntax stripped.
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="machine cursor-default text-xs text-muted-foreground">
            {formatCount(sources)} sources
          </span>
        </TooltipTrigger>
        <TooltipContent>Distinct external URLs cited in blog.md.</TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * Copy and download. An operator's next move is pasting this into a CMS, so both are one
 * click and both say so afterwards: a clipboard write that gives no sign is a click an
 * operator makes twice.
 */
function Artifacts({
  raw,
  tab,
  topicSlug,
}: {
  raw: string | null;
  tab: OutputFile;
  topicSlug: string;
}) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (raw === null) {
      return;
    }
    try {
      // The raw markdown, never the rendered HTML: the operator is pasting this into a CMS.
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      toast.success(`Copied ${tab}`, { description: "Raw markdown is on the clipboard." });
    } catch (cause) {
      // Clipboard writes are refused outside a secure context, and silence would look like a
      // copy that worked.
      toast.error("Could not copy", { description: String(cause) });
    }
  }

  function download() {
    if (raw === null) {
      return;
    }
    // Named for its topic, so the file that lands in Downloads is recognisable among twenty
    // others rather than being the twentieth blog.md.
    const filename = tab === "blog.md" ? `${topicSlug}.md` : `${topicSlug}-${tab}`;
    const url = URL.createObjectURL(new Blob([raw], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    // The object URL pins the whole file in memory until it is revoked.
    URL.revokeObjectURL(url);
    toast.success("Downloaded", { description: filename });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="outline" onClick={() => void copy()} disabled={raw === null}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied" : "Copy markdown"}
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        onClick={download}
        disabled={raw === null}
        aria-label={`Download ${tab}`}
      >
        <Download aria-hidden />
      </Button>
    </div>
  );
}

function Artifact({ name, loaded }: { name: OutputFile; loaded: Loaded | undefined }) {
  if (!loaded) {
    return (
      <div className="mx-auto max-w-[68ch] space-y-3">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-32 w-full" />
        <span className="sr-only" role="status">
          Loading {name}
        </span>
      </div>
    );
  }

  if ("error" in loaded) {
    return <ArtifactError name={name} error={loaded.error} />;
  }

  if (loaded.text.trim() === "") {
    return <p className="text-sm text-muted-foreground">This file is on disk but empty.</p>;
  }

  return (
    <>
      {name === "eval.md" ? <EvalScore text={loaded.text} /> : null}
      {/* blog.md is the one artifact a human reads rather than scans, so it is the one set as
          an article. */}
      <MarkdownView source={loaded.text} variant={name === "blog.md" ? "article" : "document"} />
    </>
  );
}

/** eval.md buries SCORE: NN in the body, and the score is the reason the operator opened
 *  this tab, so it gets lifted to the top. */
function EvalScore({ text }: { text: string }) {
  const score = extractScore(text);
  if (score === null) {
    return null;
  }
  const shipped = score >= 95;
  return (
    <div className="mb-5 flex items-baseline gap-3 rounded-md border bg-muted/40 px-4 py-3">
      <span
        className={cn("machine text-3xl font-semibold", shipped ? "text-ship" : "text-foreground")}
      >
        {score}
      </span>
      <span className="text-xs text-muted-foreground">
        {shipped
          ? "At or above 95, so this draft shipped. The first passing score is final."
          : "Below 95, so this draft went back for a surgical revise."}
      </span>
    </div>
  );
}

function ArtifactError({ name, error }: { name: OutputFile; error: ApiError }) {
  const missing = error.status === 404;
  return (
    <div className="rounded-md border border-fail/25 bg-fail-bg p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-fail">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {error.isOffline
          ? `Cannot reach the engine to read ${name}`
          : missing
            ? `No ${name} for this blog`
            : `Could not read ${name}`}
      </p>
      <p className="mt-2 text-xs text-fail/80">
        {error.isOffline
          ? "The file may well be on disk. Nothing could ask for it."
          : missing
            ? "A blog that stopped before this stage never wrote the file, and the library reads the disk rather than a cache."
            : "The engine answered with this:"}
      </p>
      {/* The engine's own words. A generic message would hide the reason to act on. */}
      <p className="machine mt-1 text-xs wrap-anywhere text-fail/80">{error.message}</p>
    </div>
  );
}

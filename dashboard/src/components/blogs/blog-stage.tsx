"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Download, FlaskConical, Pencil, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { NotFoundCard } from "@/components/shell/brand-route";
import { StatusBadge } from "@/components/shell/status-badge";
import { AnswerQuestions } from "@/components/blogs/answer-questions";
import { BlogEditor } from "@/components/blogs/blog-editor";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { PublishAction } from "@/components/blogs/publish-action";
import { SendToClient } from "@/components/blogs/send-to-client";
import {
  CommentableArticle,
  CommentsPanel,
  type SelectionDraft,
} from "@/components/blogs/selection-comments";
import { isKnownStatus } from "@/components/blogs/blogs-filter";
import { extractScore } from "@/components/blogs/markdown";
import { countSources, countWords } from "@/components/blogs/metrics";
import { readTrail, type RunTrail } from "@/components/blogs/status-trail";
import { artifactText, useArtifact, type LoadedArtifact } from "@/components/blogs/use-artifact";
import { useBlogComments } from "@/components/blogs/use-blog-comments";
import { brandHref } from "@/lib/orgs-context";
import { formatAbsolute, formatCount, formatRelative } from "@/lib/format";
import { useBlogQuestions } from "@/lib/use-blog-questions";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import type { BlogComment, BlogReviewState, BlogSummary, OutputFile } from "@/types";

/** The three narrative artifacts, as tabs. blog.md is the one that can be edited. */
const TABS: { name: OutputFile; label: string }[] = [
  { name: "blog.md", label: "Blog" },
  { name: "eval.md", label: "Eval" },
  { name: "dossier.md", label: "Dossier" },
];

/**
 * One blog's own page: the admin-review stage.
 *
 * A shipped blog lands here for a person to polish before the client receives it. The Blog
 * tab renders the article and, on a done blog, lets the operator edit it two ways: select
 * text and describe a change for Claude to apply, or open the raw markdown and type. Eval
 * and Dossier are read-only by design, because they are the pipeline's own record of how
 * the article earned its score, and editing the record would be editing history. The exit
 * is Send to client, which is what finally makes the article visible in the portal.
 *
 * Blogs in every other state render here too, read-only: the page is the one place a blog
 * is looked at closely, and a needs_review blog's question strip works here exactly as it
 * did in the old drawer.
 */
export function BlogStage({
  orgSlug,
  brandSlug,
  brandName,
  topicSlug,
  demoMode,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  topicSlug: string;
  demoMode: boolean;
}) {
  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);
  const [listError, setListError] = React.useState<ApiError | null>(null);

  // The whole brand list, not a single-blog endpoint, because that is the read the engine
  // offers and this page needs the same summary fields the library shows. One extra row
  // per sibling blog is noise; a second endpoint that can disagree with the first is not.
  const loadBlogs = React.useCallback(
    (signal?: AbortSignal) =>
      api.blogs(brandSlug, signal).then(
        (data) => {
          setBlogs(data.blogs);
          setListError(null);
        },
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          setListError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
        },
      ),
    [brandSlug],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void loadBlogs(controller.signal);
    return () => controller.abort();
  }, [loadBlogs]);

  const blog = blogs?.find((entry) => entry.topic_slug === topicSlug) ?? null;

  if (listError) {
    return <StageError error={listError} onRetry={() => void loadBlogs()} />;
  }
  if (blogs === null) {
    return <StageSkeleton />;
  }
  if (blog === null) {
    // The URL names a blog; the engine decides whether it exists. A deleted topic leaves
    // a link that still resolves to this page, and the honest answer is that it is gone.
    return (
      <NotFoundCard
        title="No such blog"
        slug={topicSlug}
        body={`${brandName} has no blog with this slug. It may have been deleted, or the link may be stale.`}
      />
    );
  }

  return (
    <TooltipProvider>
      <StageBody
        key={`${brandSlug}:${topicSlug}`}
        orgSlug={orgSlug}
        brandSlug={brandSlug}
        brandName={brandName}
        blog={blog}
        demoMode={demoMode}
        onChanged={() => void loadBlogs()}
      />
    </TooltipProvider>
  );
}

function StageBody({
  orgSlug,
  brandSlug,
  brandName,
  blog,
  demoMode,
  onChanged,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  blog: BlogSummary;
  demoMode: boolean;
  /** Re-reads the summary list: a save, a send, or an applied change moved it. */
  onChanged: () => void;
}) {
  const topicSlug = blog.topic_slug;
  const [tab, setTab] = React.useState<OutputFile>("blog.md");
  // The editor's draft lives HERE, not in the editor: Radix unmounts an inactive tab's
  // content, so a draft held inside the editor would be destroyed by a glance at the
  // Eval tab. Null means not editing.
  const [editDraft, setEditDraft] = React.useState<string | null>(null);
  const editing = editDraft !== null;

  // blog.md and status.jsonl load regardless of the open tab: the header meta is measured
  // from the draft, and the score trail from the run feed, so neither can wait for a tab.
  const article = useArtifact(brandSlug, topicSlug, "blog.md");
  const status = useArtifact(brandSlug, topicSlug, "status.jsonl");
  const other = useArtifact(brandSlug, topicSlug, tab === "blog.md" ? null : tab);

  const articleText = artifactText(article.loaded);
  const statusText = artifactText(status.loaded);
  const trail = React.useMemo<RunTrail | null>(
    () => (statusText === null ? null : readTrail(statusText)),
    [statusText],
  );

  const { byTopic, reload: reloadQuestions } = useBlogQuestions(brandSlug, [topicSlug]);
  const questionsSettled = React.useCallback(() => {
    onChanged();
    reloadQuestions();
  }, [onChanged, reloadQuestions]);

  // What this page may change. The engine enforces every bit of this; the flags only
  // decide which affordances exist on screen.
  const editable =
    !HOSTED_READONLY && !demoMode && blog.status === "done";

  const comments = useBlogComments(brandSlug, topicSlug, editable);
  const applying = comments.comments.filter((comment) => comment.state === "applying").length;

  // Where this blog sits with the client: sent, approved, and how many suggestions are
  // still open. Read beside the summary rather than derived from it, because a resolve or
  // a dismiss moves this state and refetching the whole blogs list for one chip is noise.
  const [review, setReview] = React.useState<BlogReviewState | null>(null);
  const loadReview = React.useCallback(
    (signal?: AbortSignal) =>
      api.blogReview(brandSlug, topicSlug, signal).then(
        (data) => setReview(data),
        () => {
          // Quiet on purpose: the summary seed below keeps the chips honest from the list's
          // own copy of these facts, so a failed refinement read degrades to slightly stale
          // chips rather than earning an error surface of its own.
        },
      ),
    [brandSlug, topicSlug],
  );
  React.useEffect(() => {
    const controller = new AbortController();
    void loadReview(controller.signal);
    return () => controller.abort();
  }, [loadReview]);

  // The list summary carries the same sent/approved/changes facts, so the delivery control
  // renders from them while the review read is in flight and never flashes "Send to client"
  // over a blog the client already has.
  const reviewState: BlogReviewState = review ?? {
    sent_to_client: blog.sent_to_client ?? null,
    sent_to_client_by: null,
    client_approved: blog.client_approved ?? null,
    client_approved_by: null,
    changes_requested: blog.changes_requested ?? 0,
  };

  // Announce each comment that settles, once, and re-read the article it changed. The ref
  // carries the states already seen, so a poll that returns the same settled comment twice
  // cannot toast twice.
  const seenStates = React.useRef(new Map<string, BlogComment["state"]>());
  const articleReload = article.reload;
  React.useEffect(() => {
    for (const comment of comments.comments) {
      const before = seenStates.current.get(comment.id);
      seenStates.current.set(comment.id, comment.state);
      if (before !== "applying" || comment.state === "applying") {
        continue;
      }
      // Either way the settle moved the open-changes count, and the delivery chip reads it.
      void loadReview();
      if (comment.state === "resolved") {
        toast.success("Change applied", {
          description: comment.instruction,
        });
        articleReload();
        onChanged();
      }
      // A failure is not toasted: the panel under the article carries the engine's own
      // reason, and it is the anchor the operator is already looking at.
    }
  }, [comments.comments, articleReload, onChanged, loadReview]);

  async function submitComment(draft: SelectionDraft) {
    try {
      await api.addBlogComment(brandSlug, topicSlug, draft);
    } catch (cause) {
      // Rethrown as the engine's own sentence for the composer to render inline.
      throw new Error(
        cause instanceof ApiError ? cause.message : String(cause),
      );
    }
    comments.refresh();
  }

  function dismissComment(comment: BlogComment) {
    api.deleteBlogComment(brandSlug, topicSlug, comment.id).then(
      () => {
        comments.refresh();
        // A dismissed client suggestion leaves the open-changes count, which is what stands
        // between this blog and Send again, so the chip re-reads it now.
        void loadReview();
      },
      (cause: unknown) => {
        // No form anchors a dismiss, so the refusal goes to a toast.
        toast.error("Could not dismiss the change", {
          description: cause instanceof ApiError ? cause.message : String(cause),
        });
      },
    );
  }

  function resolveComment(comment: BlogComment) {
    api.resolveBlogComment(brandSlug, topicSlug, comment.id).then(
      () => {
        // The comment is applying now: the refresh picks that up and the poll takes over,
        // exactly as it does after a comment of this side's own filing.
        comments.refresh();
        void loadReview();
      },
      (cause: unknown) => {
        // No form anchors a resolve either, so the engine's refusal goes to a toast.
        toast.error("Could not start this change", {
          description: cause instanceof ApiError ? cause.message : String(cause),
        });
      },
    );
  }

  const loaded = tab === "blog.md" ? article.loaded : other.loaded;
  const raw = artifactText(loaded);

  return (
    <div>
      <Button size="sm" variant="ghost" className="-ml-2 mb-3" asChild>
        <Link href={brandHref(orgSlug, brandSlug, "/blogs")}>
          <ArrowLeft data-icon="inline-start" aria-hidden />
          Blogs
        </Link>
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="text-xl leading-snug font-semibold tracking-tight text-pretty text-foreground">
            {blog.roadmap_index !== null ? (
              <span className="machine mr-1.5 font-normal text-muted-foreground">
                {blog.roadmap_index + 1}.
              </span>
            ) : null}
            {blog.topic}
          </h2>
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
              <TooltipContent className="machine">{formatAbsolute(blog.created)}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PublishAction
            brandSlug={brandSlug}
            topicSlug={topicSlug}
            topic={blog.topic}
            status={blog.status}
            demoMode={demoMode}
          />
          <SendToClient
            brandSlug={brandSlug}
            topicSlug={topicSlug}
            brandName={brandName}
            status={blog.status}
            demoMode={demoMode}
            review={reviewState}
            onSent={(state) => {
              // The POST answers with the state it produced, so the chip flips on the spot
              // and the summary re-read only has to agree with it.
              setReview(state);
              onChanged();
            }}
          />
        </div>
      </div>

      {demoMode ? (
        <p className="mt-3 flex gap-2 text-xs leading-relaxed text-muted-foreground">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This is a demo brand, so the article is precoded placeholder text: nothing here
          can be edited with Claude or sent to a client.
        </p>
      ) : null}

      <Card className="mt-4 gap-0 overflow-hidden p-0">
        <AnswerQuestions
          brandSlug={brandSlug}
          topicSlug={topicSlug}
          blogScore={blog.score}
          entry={byTopic.get(topicSlug)}
          review={
            blog.status === "needs_review"
              ? { note: trail?.terminalNote ?? null, pending: status.loaded === undefined }
              : null
          }
          onSettled={questionsSettled}
        />

        <Tabs value={tab} onValueChange={(value) => setTab(value as OutputFile)} className="gap-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
            <TabsList variant="line">
              {TABS.map((item) => (
                <TabsTrigger key={item.name} value={item.name} className="text-xs">
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="flex items-center gap-1.5">
              {editable && tab === "blog.md" && !editing ? (
                <EditButton
                  disabled={articleText === null || applying > 0}
                  reason={
                    applying > 0
                      ? "A Claude change is being applied. Edit once it lands, so the two writes cannot race."
                      : null
                  }
                  onClick={() => setEditDraft(articleText)}
                />
              ) : null}
              {/* Hidden while the blog tab is being edited: these export the SAVED
                  article, and offering them beside an unsaved draft exports stale text
                  the operator just rewrote. */}
              {editing && tab === "blog.md" ? null : (
                <Artifacts raw={raw} tab={tab} topicSlug={topicSlug} />
              )}
            </div>
          </div>

          {TABS.map((item) => (
            <TabsContent key={item.name} value={item.name}>
              <div className="px-4 py-6 sm:px-6">
                {item.name !== "blog.md" ? (
                  <Artifact name={item.name} loaded={item.name === tab ? loaded : undefined} />
                ) : editDraft !== null ? (
                  <BlogEditor
                    brandSlug={brandSlug}
                    topicSlug={topicSlug}
                    initial={articleText ?? ""}
                    value={editDraft}
                    onChange={setEditDraft}
                    onSaved={() => {
                      setEditDraft(null);
                      articleReload();
                      onChanged();
                    }}
                    onCancel={() => setEditDraft(null)}
                  />
                ) : (
                  <BlogArticle
                    loaded={article.loaded}
                    editable={editable}
                    remaining={3 - applying}
                    onSubmit={submitComment}
                  />
                )}

                {item.name === "blog.md" && !editing ? (
                  <>
                    {editable && comments.error !== null ? (
                      // The change log could not be read; an empty panel would claim
                      // nothing was ever filed. The engine's own words, inline.
                      <p className="mt-8 text-xs wrap-anywhere text-fail">
                        Could not read the changes for this blog: {comments.error.message}
                      </p>
                    ) : null}
                    <CommentsPanel
                      comments={comments.comments}
                      onDismiss={dismissComment}
                      onResolve={resolveComment}
                    />
                  </>
                ) : null}

                {/* The real path on disk, so an operator can open the file in Finder. */}
                <p className="machine mx-auto mt-10 max-w-[68ch] border-t pt-3 text-xs wrap-anywhere text-muted-foreground">
                  outputs/{brandSlug}/{topicSlug}/{item.name}
                </p>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </Card>
    </div>
  );
}

function EditButton({
  disabled,
  reason,
  onClick,
}: {
  disabled: boolean;
  reason: string | null;
  onClick: () => void;
}) {
  const button = (
    <Button size="sm" variant="outline" onClick={onClick} disabled={disabled}>
      <Pencil data-icon="inline-start" aria-hidden />
      Edit
    </Button>
  );
  if (reason === null) {
    return button;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}

/** The article view: commentable on a done blog, a plain read everywhere else. */
function BlogArticle({
  loaded,
  editable,
  remaining,
  onSubmit,
}: {
  loaded: LoadedArtifact | undefined;
  editable: boolean;
  remaining: number;
  onSubmit: (draft: SelectionDraft) => Promise<void>;
}) {
  if (!loaded) {
    return <ArtifactSkeleton name="blog.md" />;
  }
  if ("error" in loaded) {
    return <ArtifactError name="blog.md" error={loaded.error} />;
  }
  if (loaded.text.trim() === "") {
    return <p className="text-sm text-muted-foreground">This file is on disk but empty.</p>;
  }
  return (
    <>
      {editable ? (
        <p className="mx-auto mb-4 max-w-[68ch] text-xs text-muted-foreground">
          Select any passage to ask Claude for a change, or open Edit for the raw markdown.
        </p>
      ) : null}
      <CommentableArticle
        source={loaded.text}
        disabled={!editable}
        remaining={remaining}
        onSubmit={onSubmit}
      />
    </>
  );
}

/** eval.md and dossier.md: read-only documents, exactly as the drawer showed them. */
function Artifact({ name, loaded }: { name: OutputFile; loaded: LoadedArtifact | undefined }) {
  if (!loaded) {
    return <ArtifactSkeleton name={name} />;
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
      <MarkdownView source={loaded.text} variant="document" />
    </>
  );
}

function ArtifactSkeleton({ name }: { name: string }) {
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

/**
 * The score, and how it got there. GET /blogs reports only the final number, so "96" alone
 * cannot tell an operator whether the draft landed there or climbed from 88 over four
 * iterations. The trail is read from the engine's own eval lines; a run with one iteration
 * has nothing to show and shows nothing.
 */
function ScoreTrail({ score, trail }: { score: number | null; trail: RunTrail | null }) {
  if (typeof score !== "number") {
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
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="machine cursor-default text-xs text-muted-foreground">
            {formatCount(countWords(text))} words
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Counted the way the engine&apos;s word-count gate counts, with link syntax stripped.
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="machine cursor-default text-xs text-muted-foreground">
            {formatCount(countSources(text))} sources
          </span>
        </TooltipTrigger>
        <TooltipContent>Distinct external URLs cited in blog.md.</TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * Copy and download the open tab's raw markdown. An operator's next move is pasting this
 * into a CMS, so both are one click and both say so afterwards.
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
      // The raw markdown, never the rendered HTML: the operator is pasting into a CMS.
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      toast.success(`Copied ${tab}`, { description: "Raw markdown is on the clipboard." });
    } catch (cause) {
      toast.error("Could not copy", { description: String(cause) });
    }
  }

  function download() {
    if (raw === null) {
      return;
    }
    const filename = tab === "blog.md" ? `${topicSlug}.md` : `${topicSlug}-${tab}`;
    const url = URL.createObjectURL(new Blob([raw], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
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
          ? "At or above 95, so the evaluator passed this draft. A blog holding open questions waits for your answers whatever it scored."
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
            ? "A blog that stopped before this stage never wrote the file."
            : "The engine answered with this:"}
      </p>
      <p className="machine mt-1 text-xs wrap-anywhere text-fail/80">{error.message}</p>
    </div>
  );
}

function StageSkeleton() {
  return (
    <div>
      <Skeleton className="h-7 w-2/3 max-w-md" />
      <Skeleton className="mt-3 h-4 w-72" />
      <Skeleton className="mt-6 h-[32rem] w-full" />
      <span className="sr-only" role="status">
        Loading blog
      </span>
    </div>
  );
}

/** The engine's own reason, never a generic message: it is the only thing worth reading. */
function StageError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <Card className="border-fail/25 bg-fail-bg">
      <CardContent className="py-8 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-fail/10">
          <TriangleAlert className="size-5 text-fail" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-fail">
          {error.isOffline ? "Cannot reach the engine" : "The engine refused the request"}
        </p>
        <p className="machine mx-auto mt-2 max-w-md text-xs wrap-break-word text-fail/80">
          {error.message}
        </p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

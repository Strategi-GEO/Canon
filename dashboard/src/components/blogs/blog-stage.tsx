"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  Copy,
  Download,
  FileUp,
  FlaskConical,
  Globe,
  Laptop,
  Pencil,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { NotFoundCard } from "@/components/shell/brand-route";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { AnswerQuestions } from "@/components/blogs/answer-questions";
import { BlogEditor } from "@/components/blogs/blog-editor";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { PublishAction } from "@/components/blogs/publish-action";
import { SendToClient } from "@/components/blogs/send-to-client";
import { CommentableArticle, type SelectionDraft } from "@/components/blogs/selection-comments";
import { extractScore } from "@/components/blogs/markdown";
import { countSources, countWords } from "@/components/blogs/metrics";
import { readTrail, type RunTrail } from "@/components/blogs/status-trail";
import { artifactText, useArtifact, type LoadedArtifact } from "@/components/blogs/use-artifact";
import { useBlogComments } from "@/components/blogs/use-blog-comments";
import { brandHref } from "@/lib/orgs-context";
import {
  adminActions,
  adminAnswerTierReady,
  adminCan,
  adminWriteTierReady,
  blogState,
} from "@/lib/blog-state";
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
 * tab renders the article inside the shared comment rail, so every change request sits level
 * with the passage it annotates, the client's and this side's alike, and lets the operator
 * edit it two ways: select text and describe a change for Claude to apply, or open the raw
 * markdown and type. The rail is where a client suggestion is resolved, replied to, or
 * dismissed, which is why it renders here rather than only in the portal. Eval
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

  // Where this blog sits with the client: sent, approved, and how many suggestions are
  // still open. Read beside the summary rather than derived from it, because a resolve or
  // a dismiss moves this state and refetching the whole blogs list for one chip is noise.
  //
  // Read BEFORE the comments hook, because it is what decides whether the comments poll runs
  // at all: a sent blog has a second author filing things from a portal this app cannot hear.
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
    // The ROUND, seeded like the rest, and it is the field that decides whether Send even
    // renders on this page. Without it in the seed the stage would read `client_review` for
    // the whole time the review fetch is in flight, so an operator arriving mid round would
    // watch the Send button appear a beat late, or on the hosted build never at all.
    change_round_open: blog.change_round_open ?? false,
    // Seeded from the list for the same reason as the fields above, and it matters more here:
    // the hosted build has no /review route at all, so this seed is the ONLY source of the
    // publish stamp there. Null is "no record of a push", which the chip renders as nothing.
    published: blog.published ?? null,
    cms_status: blog.cms_status ?? null,
  };

  /**
   * WHERE THIS ARTICLE IS, computed once, from the record and nothing else.
   *
   * The summary and the review read are merged because they carry the same delivery facts at
   * different ages: the summary is the blogs list's copy from page load, and the review read is
   * this page's own, re-read on every resolve, dismiss and send. reviewState spreads LAST so the
   * fresher one wins, and it already falls back to the summary's fields while its own request is
   * in flight, so the merge never opens a hole where a sent blog reads as unsent.
   */
  const state = blogState({ ...blog, ...reviewState });

  /**
   * WHAT THE STATE PERMITS. This replaces a single `blog.status === "done"` flag that governed
   * everything, and the reason it had to go is that `done` is not a place: it was equally true of
   * an article on the refining bench, one the client is reading right now, one they have approved,
   * and one already in the CMS. Those are four situations with four different sets of doors, so
   * one flag over all of them offered an edit that rewrote bytes somebody was mid-review of.
   *
   * demoMode is ANDed in rather than modelled as a state, because a demo brand is a property of
   * the CLIENT and not a place an article sits. Its blogs are precoded placeholder text, so no
   * act on this page means anything for one, whatever state the record is in.
   *
   * adminWriteTierReady IS THE DISCRIMINATING LAYER `edit` AND `comments` NEVER HAD, and its
   * absence is the defect that shipped three times. `send` has had one since it was written, in
   * SendToClient's blockedReason reading the status, and `answer` has had one in AnswerQuestions
   * reading the form. These two were granted off the state bench with nothing in front of them, so
   * in the one state whose status is not fixed by its own definition, `answers_submitted`, both
   * controls rendered over a record migration 009 refuses: the Edit button saved into a
   * PORTAL:NOTDONE and the selection composer filed a comment into the same one. blog-state.ts
   * carries the full reasoning, including why the state is not split in two instead.
   *
   * READ OFF `blog` RATHER THAN OFF `state`, on purpose and unavoidably. The status is exactly the
   * fact the state folds away, so composing the bench with the record is the only way to get it
   * back, and reaching for `state` here would reproduce the bug one line lower down.
   */
  const canEdit =
    !demoMode && !HOSTED_READONLY && adminCan(state, "edit") && adminWriteTierReady(blog);
  /**
   * NO HOSTED_READONLY TERM HERE, DELIBERATELY, and canEdit above carries one. They differ because
   * this flag has a second consumer: commentsVisible reads it to decide whether the rail is
   * FETCHED, and an admin on the hosted build must still be able to read what the client asked
   * for. Folding the deployment axis in here would empty the margin beside the article on the
   * build that exists mostly to read them. The write half of this axis is canRunClaude below,
   * which is what the composer and the resolve doors are gated on.
   */
  const canComment = !demoMode && adminCan(state, "comments") && adminWriteTierReady(blog);
  const canSend = !demoMode && adminCan(state, "send");
  const canPublish = !demoMode && adminCan(state, "publish");
  /**
   * adminAnswerTierReady IS THE LAYER `answer` WAS BELIEVED TO HAVE AND DID NOT, and its absence
   * is round four of the same defect the two flags above closed in round three.
   *
   * The claim it replaces was that AnswerQuestions discriminates on its own, finding no form once
   * the revise's finally-arm has cleared it. The panel reads the RECORD rather than the disk, and
   * server/sync.py spares answered evaluator rows from the post-revise delete, so the form
   * survives; questions-state.ts modeOf tests `answered` before `stale`, so an answered stale form
   * takes the answered branch and draws "Rerun with their answers"; and server/app.py:1538 refuses
   * that rerun as stale. The control rendered and 409'd on every record in `answers_submitted`
   * except the one where the rerun has genuinely not run.
   *
   * READ OFF `blog` RATHER THAN OFF `state`, for the same unavoidable reason canEdit is: the
   * status is the fact the state folds away, and the form's currency is derivable from the status
   * and from nothing else this page holds.
   */
  const canAnswer = !demoMode && adminCan(state, "answer") && adminAnswerTierReady(blog);
  /**
   * REPLYING IN AN EXISTING THREAD, which is a door of its own now and not a corner of `comments`.
   *
   * ORed with canComment because the two grants are disjoint by construction: blog-state.ts hands
   * out `reply` only in the three states where the rail is read and `comments` is withheld, so
   * this reads as "the fuller bench, or the reply door alone". Where `comments` is granted the
   * reply box already rides on it and always has.
   *
   * HOSTED_READONLY IS IN HERE AND NOT IN canComment, and the split is the same one canRunClaude
   * makes: canComment feeds commentsVisible, which must keep FETCHING the rail on the hosted
   * build, while this feeds a control that writes. blogs/[topic]/comments/[id]/reply/route.ts
   * answers 501 hostedWriteRefused, so offering the box there would be the deployment-axis twin of
   * the bench defect this file keeps closing.
   */
  const canReply = !demoMode && !HOSTED_READONLY && (canComment || adminCan(state, "reply"));

  /**
   * WHAT STILL NEEDS AN ENGINE, and it is a SEPARATE AXIS that stays separate.
   *
   * Every flag above asks what the state permits. This asks whether an engine exists to do the
   * work, which is a fact about the deployment and not about the article: resolving a comment
   * with Claude is an Agent SDK session rather than a row, so a definer function can file the
   * request and cannot run it. Folding the two would make the hosted build look as though its
   * articles were in a different state, and they are not. Same article, same state, on a build
   * that cannot spend a session on it, so the rail shows the comment as a queued request.
   *
   * IT GATES THE COMPOSER AS WELL AS THE RESOLVE DOORS, which it did not before and should have.
   * blogs/[topic]/comments/route.ts answers 501 hostedWriteRefused, so FILING a change request on
   * the hosted build fails exactly as resolving one does, and the composer was rendering there in
   * every state that granted `comments`. Passing canComment straight through offered a control the
   * route refuses, which is the same offered-but-refused shape as the bench defect above, on the
   * deployment axis rather than the record axis.
   */
  const canRunClaude = !HOSTED_READONLY && canComment;

  /**
   * The rail is READ even where the admin may not act on it, and that is deliberate.
   *
   * A client's suggestions are the whole reason an article comes back, so an admin looking at a
   * blog that is out for review, approved or published has to be able to see what was said about
   * it. Leaving the hook idle in those states would render an empty margin beside the article,
   * which claims nobody has asked for anything: strictly worse than being unable to act, because
   * it is wrong rather than merely limited. What the state decides is whether those cards carry
   * doors, and that is `canComment` below, not this.
   *
   * `answers_submitted` IS DELIBERATELY NOT REACHED BY THIS TEST, and the line it draws is a SEND
   * rather than "with the team". Every state that reaches it is at or past a send, which is the
   * only way a client suggestion can exist: clientActions offers `suggest` in client_review alone.
   * `answers_submitted` carries no send stamp by construction, because a send outranks it in
   * blogState's ladder, so there is no client conversation for the margin to omit. Adding it
   * would buy a fetch that can only come back empty, and it would put this out of step with
   * has_questions and generating, which sit in exactly the same position and are also absent.
   *
   * THE THREE STATES ARE NOW NAMED BY THE GRANT RATHER THAN LISTED BY HAND, and it is the same
   * three: blog-state.ts hands `reply` to client_review, approved and published, which is exactly
   * the set this list used to spell out. Reading it off the bench ties the fetch to the reason for
   * the fetch, so a future state that gains a reply door gets its rail read without anyone
   * remembering to come back here, and one that loses the door stops paying for a rail nobody can
   * use. HOSTED_READONLY is deliberately not consulted, because reading is exactly what that build
   * is for: this is `adminCan` and not `canReply`.
   */
  const commentsVisible = canComment || adminCan(state, "reply");

  /**
   * The draft the editor is actually holding, and null the moment the state stops permitting an
   * edit. A client approving while this page sits open locks the article for everyone, this side
   * included, so a textarea left standing over that promises a save the engine refuses. Dropping
   * back to the read view says so by construction, and the tag beside the title says why.
   */
  const editorDraft = canEdit ? editDraft : null;

  // Read once per visit, then watched only while an apply this operator started is settling.
  // A client's suggestion arriving is NOT watched for: it lands in the bell at the next read
  // of the blogs library, which is what a refresh is for.
  const comments = useBlogComments(brandSlug, topicSlug, commentsVisible);
  const applying = comments.comments.filter((comment) => comment.state === "applying").length;

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

  /**
   * Answers one comment in its thread. Nothing else moves: the parent keeps its state, so a
   * reply is how an operator says "we cut that line, it was a duplicate" without spending a
   * session on the request or making it disappear from the client's rail.
   *
   * The refusal is RETHROWN rather than toasted, because the reply box is a form and the
   * engine's sentence belongs beside the words that caused it.
   */
  async function replyToComment(comment: BlogComment, body: string) {
    try {
      await api.replyToBlogComment(brandSlug, topicSlug, comment.id, body);
    } catch (cause) {
      throw new Error(cause instanceof ApiError ? cause.message : String(cause));
    }
    comments.refresh();
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
            {/* WHERE THE ARTICLE IS, which is not the same fact as how the run ended.
                StatusBadge read "shipped" for a blog on the bench, one the client was mid
                review of, one they had already approved and one sitting in the CMS. Those
                are four situations offering four different sets of controls on this very
                page, so the badge was contradicting the buttons under it. The tag names the
                one state this blog is in, and its tooltip names who owes the next act, which
                is the sentence that explains every control this page then declines to show. */}
            <BlogStateTag state={state} audience="admin" />
            {/* An uploaded blog gets the provenance chip INSTEAD of a score trail. A bare
                "no score" beside a shipped article reads as a missing number, which invites
                the operator to go looking for the evaluation that failed to run. There was
                none to run, and saying so is the more useful sentence. */}
            {blog.uploaded === true ? (
              <UploadedChip />
            ) : (
              <ScoreTrail score={blog.score} trail={trail} />
            )}
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
          {/* Left of the button that produces it, matching how SendToClient puts its own
              state chip beside its own control. It renders on the hosted build too, where
              PublishAction is absent: the record of a push is worth reading even where the
              push itself cannot be made. */}
          <PublishedChip published={reviewState.published} cmsStatus={reviewState.cms_status} />
          {/* GONE RATHER THAN GREYED wherever the state refuses them, both of these.

              A disabled Post to CMS on an article the client has not approved yet, or a
              disabled Send on one they are reading right now, is a control an operator has to
              read and reject on every single visit, and the first thing they do about it is go
              hunting for the switch that turns it on. There is no switch: the answer is the
              state, and the tag beside the title already carries it in words. An absent control
              next to an explained state is legible; a dead control next to it is a puzzle.

              THE DISABLED PATTERN SURVIVES INSIDE these components, and only for the reasons
              that clear on their own: demo mode, a Claude apply already in flight, the engine's
              one-session cap. Those are conditions to wait out, so a button that comes back is
              the honest shape for them. A state is not a condition to wait out.

              PublishAction keeps its own HOSTED_READONLY gate, untouched. That axis is about
              whether an engine exists to make the push, not about where the article sits, and
              the two compose here rather than either one swallowing the other. */}
          {canPublish ? (
            <PublishAction
              brandSlug={brandSlug}
              topicSlug={topicSlug}
              topic={blog.topic}
              status={blog.status}
              demoMode={demoMode}
            />
          ) : null}
          {/* THE STAMP IS A FACT, NOT A CONTROL, so it survives the gating that removes the
              control. Gating Send on `canSend` was correct and it took the timestamp with it,
              because SendToClient rendered both: in client_review and approved the operator
              could no longer see WHEN the article went out or WHO sent it. The tag says where
              the article is and cannot say that, because a tag is per state and this is per
              record. Rendered whenever the record carries a stamp, which is exactly the set of
              states where the control is gone, so the two never double up. */}
          <ReviewStamp review={reviewState} />
          {canSend ? (
            <SendToClient
              brandSlug={brandSlug}
              topicSlug={topicSlug}
              brandName={brandName}
              status={blog.status}
              demoMode={demoMode}
              review={reviewState}
              onSent={(sent) => {
                // The POST answers with the review state it produced, so the chip flips on the
                // spot and the summary re-read only has to agree with it. Named `sent` rather
                // than `state` because this scope now holds the blog's own BlogState, and two
                // different `state`s one line apart is how the wrong one gets spread.
                //
                // SPREAD OVER THE CURRENT STATE rather than replacing it. A send moves the
                // client half of this record and touches nothing in the CMS half, and the
                // hosted send RPC is admin_send_blog_to_client from migration 009, which
                // predates 012 and answers with the review fields alone. Taking its answer
                // whole would drop the publish stamp out of state and blank a Published chip
                // that is still true.
                setReview({ ...reviewState, ...sent });
                onChanged();
              }}
            />
          ) : null}
        </div>
      </div>

      {demoMode ? (
        <p className="mt-3 flex gap-2 text-xs leading-relaxed text-muted-foreground">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This is a demo brand, so the article is precoded placeholder text: nothing here
          can be edited with Claude or sent to a client.
        </p>
      ) : null}

      {/* THE HOSTED BUILD OWES THE OPERATOR THIS SENTENCE, and until now it said nothing at all.
          Every admin write route on this build answers 501 hostedWriteRefused, and every control
          is REMOVED rather than greyed: SendToClient returns null, PublishAction returns null,
          canEdit carries a !HOSTED_READONLY term, and canRunClaude gates the composer and the
          resolve doors. That is the right shape for a control, and it leaves the page mute.

          MUTE IS NOT NEUTRAL, because the tag beside the title is still ISSUING AN INSTRUCTION.
          ADMIN_TAGS says this article is on your bench to refine and send, the operator reads it,
          finds no bench, and goes hunting for the switch that turns one on. There is no switch:
          the acts live in the app on their own machine. A bench that is honest locally and silent
          hosted is still dishonest, so the page says where the acts went.

          KEYED ON THE BENCH BEING NON-EMPTY rather than on a list of states, so it appears exactly
          where something was withheld and stays away from `generating`, `failed`, `stopped` and
          `unknown`, which offer nothing on either build and would be told they are missing acts
          they never had. demoMode is deliberately not ANDed out: a demo brand on the hosted build
          is refused twice over, and both refusals are true. */}
      {HOSTED_READONLY && adminActions(state).length > 0 ? (
        <p className="mt-3 flex gap-2 text-xs leading-relaxed text-muted-foreground">
          <Laptop className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This is the hosted view of the record, so it reads and never writes. Answering the
          evaluator, editing, asking Claude for a change, sending to the client and posting to the
          CMS all run in the Canon app on your own machine, which is why none of those controls
          are on this page.
        </p>
      ) : null}

      <Card className="mt-4 gap-0 overflow-hidden p-0">
        {/* THE ANSWER FORM, AND THE RERUN, in the two states where one of them is owed.
            adminActions gives `answer` to has_questions AND to answers_submitted, and the verb
            covers two acts because they are two moments of one panel reading one file: answer
            what the evaluator asked, or dispatch the rerun that applies answers the client has
            already filed from their portal. AnswerQuestions decides which it is looking at from
            the form's own state, so it draws the Rerun strip only where a client-answered form is
            live and draws nothing where the revise's finally-arm has already cleared it. That is
            the discriminating layer this mount relies on, and it is why the grant is safe in a
            state that spans two statuses. Every other state has nothing anyone can answer, and a
            form offered there would be a demand with no obligation behind it.

            The strip also carries its own historical notes, a superseded form or the outcome of
            a revise that has already landed, and those go with it. They report on a demand that
            is discharged, and what they were reporting, the score the answers bought, is in the
            eval tab and in the score trail above. */}
        {canAnswer ? (
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
        ) : null}

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
              {/* The button is absent where the state refuses an edit, and DISABLED where the
                  state allows one but this moment does not. That split is the whole rule on
                  this page: an in-flight Claude apply clears by itself, so the button stays and
                  explains itself, while an approved article never reopens and a greyed control
                  over it would be an invitation to look for a way in. */}
              {canEdit && tab === "blog.md" && editorDraft === null ? (
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
              {editorDraft !== null && tab === "blog.md" ? null : (
                <Artifacts raw={raw} tab={tab} topicSlug={topicSlug} />
              )}
            </div>
          </div>

          {TABS.map((item) => (
            <TabsContent key={item.name} value={item.name}>
              <div className="px-4 py-6 sm:px-6">
                {item.name !== "blog.md" ? (
                  <Artifact
                    name={item.name}
                    loaded={item.name === tab ? loaded : undefined}
                    uploaded={blog.uploaded === true}
                  />
                ) : editorDraft !== null ? (
                  <BlogEditor
                    brandSlug={brandSlug}
                    topicSlug={topicSlug}
                    baseVersion={blog.version_no ?? null}
                    initial={articleText ?? ""}
                    value={editorDraft}
                    onChange={setEditDraft}
                    onSaved={() => {
                      setEditDraft(null);
                      articleReload();
                      onChanged();
                    }}
                    onCancel={() => setEditDraft(null)}
                  />
                ) : (
                  <>
                    {/* Keyed to whether the rail was FETCHED, not to whether it can be acted
                        on. An admin who may only read the client's suggestions still has to
                        know the read failed, because the empty margin beside the article
                        otherwise claims nobody asked for anything. */}
                    {commentsVisible && comments.error !== null ? (
                      // The rail could not be read, and an article with an empty margin
                      // beside it would claim nobody has asked for anything. The engine's
                      // own words, above the piece they are about.
                      <p className="mb-4 text-xs wrap-anywhere text-fail">
                        Could not read the comments on this blog: {comments.error.message}
                      </p>
                    ) : null}
                    {/* canComment is passed canRunClaude, not canComment: the composer is a WRITE
                        and the hosted route refuses it, so the flag that carries the deployment
                        axis is the one this prop wants. canComment stays the permission axis up
                        there because commentsVisible reads it to decide whether the rail is read
                        at all, which the hosted build must keep doing. */}
                    <BlogArticle
                      loaded={article.loaded}
                      canComment={canRunClaude}
                      canResolve={canRunClaude}
                      canReply={canReply}
                      /* THE STATE WOULD TAKE A CHANGE AND THIS BUILD WILL NOT, which is a
                         different sentence from "this article is closed" and the rail was
                         printing the wrong one. canComment carries no HOSTED_READONLY term, so
                         this is true exactly where the article is open and the deployment is
                         what refuses. In client_review, approved and published it is false and
                         the state's own sentence stands, which is the right precedence: telling
                         an operator to open the local app for an act that is absent there too
                         sends them somewhere for nothing. */
                      deploymentLocked={canComment && !canRunClaude}
                      remaining={3 - applying}
                      comments={comments.comments}
                      onSubmit={submitComment}
                      onDismiss={dismissComment}
                      onResolve={resolveComment}
                      onReply={replyToComment}
                    />
                  </>
                )}

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

/**
 * The article view: commentable where the state permits it, with the review rail beside it,
 * and a plain read everywhere else.
 *
 * READ-ONLY IS NOT THE SAME AS ABSENT here. On an article the client is reading, has approved,
 * or that is already in the CMS, the rail still renders every suggestion filed against it. What
 * goes is the composer and the doors on each card, because none of those acts is permitted
 * then. Hiding the whole rail instead would hide the record of a conversation that actually
 * happened.
 */
function BlogArticle({
  loaded,
  canComment,
  canResolve,
  canReply,
  deploymentLocked,
  remaining,
  comments,
  onSubmit,
  onDismiss,
  onResolve,
  onReply,
}: {
  loaded: LoadedArtifact | undefined;
  /** Whether the STATE lets this side file, resolve, dismiss or reply to a change. */
  canComment: boolean;
  /** Whether an engine is behind this page, so a Claude session can actually run. Threaded
   *  from StageBody rather than read off HOSTED_READONLY down here, so the one flag that
   *  already knows the answer is the only thing the rail can disagree with. */
  canResolve: boolean;
  /** Whether a reply may be filed in an existing thread. A door of its own, so it survives on
   *  an article that takes no other change: see blog-state.ts's `reply`. */
  canReply: boolean;
  /** Whether the read-only rail is read-only because of the DEPLOYMENT rather than the state.
   *  It decides which sentence a card owed an act prints, and the two are not interchangeable:
   *  one names a state that will change, the other names a build that will not. */
  deploymentLocked: boolean;
  remaining: number;
  comments: BlogComment[];
  onSubmit: (draft: SelectionDraft) => Promise<void>;
  onDismiss: (comment: BlogComment) => void;
  onResolve: (comment: BlogComment) => void;
  onReply: (comment: BlogComment, body: string) => Promise<void>;
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
      {canComment ? (
        // Above BOTH columns and no longer centred on the article's measure: it describes
        // the whole surface now, rail included. It also stays OUTSIDE the rail's container
        // deliberately, because everything inside that container is selectable text a
        // comment can be filed against, and a hint sentence is not part of the article.
        <p className="mb-4 text-xs text-muted-foreground">
          Select any passage to ask Claude for a change, or open Edit for the raw markdown.
          Comments from the client sit beside the passage each one is about.
        </p>
      ) : null}
      <CommentableArticle
        source={loaded.text}
        comments={comments}
        disabled={!canComment}
        canResolve={canResolve}
        canReply={canReply}
        deploymentLocked={deploymentLocked}
        remaining={remaining}
        onSubmit={onSubmit}
        onDismiss={onDismiss}
        onResolve={onResolve}
        onReply={onReply}
      />
    </>
  );
}

/** eval.md and dossier.md: read-only documents, exactly as the drawer showed them. */
function Artifact({
  name,
  loaded,
  uploaded,
}: {
  name: OutputFile;
  loaded: LoadedArtifact | undefined;
  /** An uploaded article has neither of these files, and that is not a fault. */
  uploaded: boolean;
}) {
  if (!loaded) {
    return <ArtifactSkeleton name={name} />;
  }
  // BEFORE the error branch, because for an uploaded blog this 404 is the expected answer
  // and not a failure. ArtifactError would paint a red panel reading "a blog that stopped
  // before this stage never wrote the file", which is alarming and, here, untrue: nothing
  // stopped, the factory simply never ran. A non-404 still falls through and is reported,
  // since "the engine is unreachable" is a real fault whatever wrote the blog.
  if (uploaded && "error" in loaded && loaded.error.status === 404) {
    return <NoFactoryArtifact name={name} />;
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

/**
 * What the Eval and Dossier tabs say for an article nobody generated.
 *
 * Muted, not red. The absence is the honest consequence of how this blog arrived: an
 * operator wrote it elsewhere and handed it over, so no researcher built a dossier and no
 * evaluator scored it. Styling that as a failure would tell the operator something is wrong
 * with a blog that is doing exactly what they asked, and the red panel beside it is reserved
 * for a file that genuinely should exist.
 *
 * It names what is missing rather than hiding the tab. An operator who opens Eval on this
 * blog is asking a real question, "what did the auditor say", and the answer is that nothing
 * audited it, which is worth stating plainly before they trust the article on that basis.
 */
function NoFactoryArtifact({ name }: { name: OutputFile }) {
  const isEval = name === "eval.md";
  return (
    <div className="rounded-md border border-border bg-muted/40 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <FileUp className="size-4 shrink-0" aria-hidden />
        {isEval ? "This blog was not scored" : "This blog has no dossier"}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {isEval
          ? "It was uploaded rather than generated, so no evaluator audited it and there is no score to read. Whoever uploaded it vouched for it."
          : "It was uploaded rather than generated, so no researcher built a source dossier for it. The article's own sources are in the blog itself."}
      </p>
    </div>
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
 * The provenance chip an uploaded blog wears where a generated one wears its score.
 *
 * It states the warrant. A generated blog is trusted because an evaluator scored it at or
 * above the ship band; an uploaded one is trusted because a person handed it over and said
 * so. Both are legitimate ways to reach admin review, and an operator deciding whether to
 * send this article to a client deserves to know which one they are looking at.
 */
function UploadedChip() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          <FileUp className="size-3.5" aria-hidden />
          Uploaded
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        This article was uploaded rather than generated, so the factory never researched,
        gated or scored it. It edits, comments and sends exactly like any other blog.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * WHEN the article went to the client, and who sent or approved it.
 *
 * This exists because gating the Send control on `canSend` correctly removed a BUTTON and
 * incorrectly removed a FACT along with it. SendToClient rendered both: the control, and a chip
 * carrying the send or approval timestamp with the person's email in its tooltip. In
 * client_review and approved the control must go, and the operator was left unable to see when
 * they released the article or who approved it.
 *
 * The state tag cannot carry this. A tag is per STATE and says the same sentence for every
 * article in it; this is per RECORD. They sit next to each other and answer different questions:
 * the tag says where the article is, this says when it got there.
 *
 * IT RENDERS NOTHING BEFORE THE FIRST SEND, so it never doubles up with the control it
 * complements: the states that carry a stamp are exactly the states where Send is gated away,
 * and internal_review has both a Send button and nothing to report.
 */
function ReviewStamp({ review }: { review: BlogReviewState }) {
  const sent = review.sent_to_client;
  if (sent === null) {
    return null;
  }
  // The approval is the later act and supersedes the send in this one line. Both remain
  // readable: the tooltip carries the absolute time and the person for whichever is shown, and
  // the send date is not lost, because an approval cannot exist without one.
  //
  // Bound to a LOCAL first, rather than tested through `review.client_approved !== null` and
  // read back off the object afterwards. The two are the same value to a reader and not to the
  // compiler: a property access cannot stay narrowed across the lines between, so the second
  // read is `string | null` again and the formatters reject it. Widening the formatters or
  // asserting non-null here would both trade a real check for a claim.
  const approvedAt = review.client_approved;
  const when = approvedAt ?? sent;
  const who = approvedAt === null ? review.sent_to_client_by : review.client_approved_by;
  const approved = approvedAt !== null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default items-center gap-1.5 text-xs text-muted-foreground">
          {approved ? (
            <CheckCheck className="size-3.5" aria-hidden />
          ) : (
            <Check className="size-3.5" aria-hidden />
          )}
          {approved ? "Approved" : "Sent"} {formatRelative(when)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="machine">
          {approved ? "Approved by the client " : "Sent to the client "}
          {formatAbsolute(when)}
          {who ? ` by ${who}` : ""}
          {/* The send date survives an approval rather than being replaced by it: the chip can
              only show one, and "when did this go out" stays a question worth answering after
              the client has said yes. `sent` is the narrowed local, so this needs no second
              null test that the compiler would not believe anyway. */}
          {approved ? `. Sent ${formatAbsolute(sent)}.` : "."}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * That this article reached the CMS, and NOTHING about the case where it did not.
 *
 * A NULL STAMP RENDERS NOTHING, and that silence is the whole design of this chip rather than a
 * gap in it. Migration 012 added published_at with no backfill on purpose: nothing recorded the
 * pushes made before it, so a null is the absence of a RECORD and not evidence that the article
 * was never pushed. "Not published" would state as fact something the column cannot support, and
 * an operator would act on it by publishing a second time. The positive fact is the only one
 * this app is in a position to say.
 *
 * cms_status is the CMS's own word for the post, and it is null on the hosted build, which reads
 * the timestamp alone. So the live sentence is claimed ONLY where the CMS itself said published;
 * a draft and an unknown alike settle on the weaker one, that the push happened. Green is
 * reserved for the same reason: a live article is a finished thing, a draft is an editor's queue.
 */
function PublishedChip({
  published,
  cmsStatus,
}: {
  published: string | null;
  cmsStatus: string | null;
}) {
  if (published === null) {
    return null;
  }
  const live = cmsStatus === "published";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex cursor-default items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium",
            live
              ? "border-ship/25 bg-ship/10 text-ship"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          <Globe className="size-3.5" aria-hidden />
          {live ? "Live in the CMS" : "Posted to CMS"} {formatRelative(published)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <span className="machine">{formatAbsolute(published)}</span>.{" "}
        {live
          ? "The CMS reports this post as published, so an editor has already taken it live and posting again will not change it."
          : "This is the push, not the publication. An editor decides in the CMS whether the draft goes out."}
      </TooltipContent>
    </Tooltip>
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

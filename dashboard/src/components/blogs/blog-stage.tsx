"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  CheckCheck,
  FileUp,
  ExternalLink,
  Globe,
  Laptop,
  Pencil,
  Redo2,
  RotateCw,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { NotFoundCard } from "@/components/shell/brand-route";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { BELOW_BAR_FLOOR, SHIP_BAR, adminFailedTag, scoreClass, scoreTone } from "@/lib/blog-score";
import { blogLabels } from "@/lib/blog-label";
import { AnswerQuestions } from "@/components/blogs/answer-questions";
import { BlogEditor } from "@/components/blogs/blog-editor";
import { MarkdownActions } from "@/components/blogs/markdown-actions";
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
import { useClients } from "@/lib/clients-context";
import {
  adminActions,
  adminCan,
  blogState,
  type BlogState,
  type BlogStateFacts,
} from "@/lib/blog-state";
import {
  adminGateAllows,
  adminGateStanding,
  type GateApplying,
  type GateForm,
  type GateInput,
} from "@/lib/gate-contract";
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
 * Whether the comment rail is FETCHED for a state, which is a question about reading and never
 * about writing.
 *
 * The rail is READ even where the admin may not act on it, and that is deliberate. A client's
 * suggestions are the whole reason an article comes back, so an admin looking at a blog that is
 * out for review, approved or published has to be able to see what was said about it. Leaving the
 * hook idle in those states would render an empty margin beside the article, which claims nobody
 * has asked for anything: strictly worse than being unable to act, because it is wrong rather than
 * merely limited. What the state decides is whether those cards carry doors, and that is
 * `canComment`, not this.
 *
 * IT READS THE BENCH ALONE, AND IT USED TO READ `canComment`, WHICH IS NOW A CYCLE. Two refusals
 * in the gate turn on how many changes are mid-apply, that count comes from this rail, and the
 * flag this used to depend on now comes out of the gate. Cutting the dependency is also the more
 * correct shape on its own terms: the gate decides whether the record will take a WRITE, and
 * gating a READ on a write refusal is a category error. The practical difference is that the rail
 * is now fetched in a few states where every write is refused, which costs one GET and buys the
 * margin its contents.
 *
 * `answers_submitted` IS DELIBERATELY NOT REACHED BY THIS TEST, and the line it draws is a SEND
 * rather than "with the team". Every state that reaches it is at or past a send, which is the only
 * way a client suggestion can exist: clientActions offers `suggest` only in client_review and
 * changes_requested, both of which sit past a send.
 * `answers_submitted` carries no send stamp by construction, because a send outranks it in
 * blogState's ladder, so there is no client conversation for the margin to omit.
 *
 * THE ONE READ STATE IS NAMED BY HAND NOW. client_review is where the client may be writing
 * notes this side must see before it can act, so the rail is read there even though every
 * write is refused. APPROVED AND PUBLISHED ARE DELIBERATELY ABSENT: an approval ends the
 * conversation, no comment is shown on either side after it, and the article takes the full
 * measure instead of holding an empty margin for a rail that will never fill. HOSTED_READONLY
 * is deliberately not consulted, because reading is exactly what that build is for.
 */
function commentRailVisible(state: BlogState): boolean {
  return adminCan(state, "comments") || state === "client_review";
}

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
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  topicSlug: string;
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
  // Same source-grouped label the blogs table shows (number for AI, letter for uploaded), computed
  // over the whole list so this page and the table always agree on what to call this blog.
  const blogLabel = blogs ? blogLabels(blogs).get(topicSlug) ?? null : null;

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
        label={blogLabel}
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
  label,
  onChanged,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  blog: BlogSummary;
  /** This blog's source-grouped identifier (number for AI, letter for uploaded), computed by the
   *  parent over the full list so the header and the blogs table always agree. */
  label: string | null;
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

  /**
   * THE QUESTION FORM AS THE GATE CONTRACT NEEDS IT, which is the two fields POST /answers and
   * POST /revise actually read and nothing else.
   *
   * THREE OUTCOMES, AND FLATTENING ANY TWO OF THEM IS A DEFECT. A topic missing from the map has
   * not been read yet, and "not read yet" is not a fact about anything: the contract answers
   * `unknowable` for it and every control that depends on the form is withheld until the read
   * lands. A present entry with a null payload is the engine's own 404, which IS a fact and means
   * there is no form. An entry carrying the engine's error is NOT a 404 and must never be read as
   * one, because a page that cannot say whether a form exists must not claim there is none, so it
   * degrades to "unread" and withholds rather than to "absent" and refuses with a reason it did
   * not earn.
   */
  const questionForm = React.useMemo<GateForm>(() => {
    const entry = byTopic.get(topicSlug);
    if (entry === undefined || entry.error !== null) {
      return "unread";
    }
    if (entry.payload === null) {
      return "absent";
    }
    return { stale: entry.payload.stale, answered: entry.payload.answered };
  }, [byTopic, topicSlug]);

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
   * THE ONE RECORD THIS PAGE REASONS ABOUT, and the single source for BOTH the state machine and
   * the gate contract.
   *
   * The summary and the review read are merged because they carry the same delivery facts at
   * different ages: the summary is the blogs list's copy from page load, and the review read is
   * this page's own, re-read on every resolve, dismiss and send. reviewState spreads LAST so the
   * fresher one wins, and it already falls back to the summary's fields while its own request is
   * in flight, so the merge never opens a hole where a sent blog reads as unsent.
   *
   * IT IS A NAMED VALUE BECAUSE THE TWO CONSUMERS DRIFTED APART THE MOMENT THEY WERE WRITTEN
   * SEPARATELY. `state` was computed from this merge and `gateInput` was built from `blog` alone,
   * which meant the state machine and the gate were answering about DIFFERENT VERSIONS OF THE SAME
   * BLOG. That difference is invisible in the UI, because both produce a button that is simply
   * there or not there, and it surfaces only as a refused action: the gate passing on stale facts
   * while the engine refuses on fresh ones is a 409 in the operator's face, and the gate refusing
   * on stale facts while the engine would accept is the dead-end where an operator resolves every
   * suggestion and has no send button left. Both were reachable, and both are the same defect this
   * whole area keeps reproducing: two layers keyed differently, with nothing making them agree.
   *
   * DERIVING BOTH FROM ONE VALUE IS THE POINT, rather than fixing the one call site. A future edit
   * that adds a third consumer, or changes what the merge contains, cannot update one reader and
   * miss the other, because there is only one thing to read. Anything on this page that asks where
   * the article is, or whether the record will take an act, asks THIS.
   *
   * WHY THE MERGE IS THE RIGHT RECORD AND NOT MERELY THE ONE ALREADY IN USE. Two things had to
   * hold and both were checked rather than assumed. First, reviewState is the fresher read on
   * every path that separates them: dismissComment and resolveComment call loadReview() and NOT
   * onChanged(), and the comment-settle effect calls loadReview() unconditionally while calling
   * onChanged() only for a resolve, so the summary's delivery fields go stale while this page is
   * open and the review's do not. `status` is not on the review read at all and comes from the
   * summary, which is why the merge and not the review alone is the answer. Second, the merge
   * cannot make a fact ABSENT that was present, which matters because absent reads as false and
   * would flip a refusal silently: BlogSummary declares all five delivery fields optional while
   * BlogReviewState declares all five required, and the seed below fills every one of them, so
   * the spread can only make a fact more present. A JSON body cannot carry an `undefined` value,
   * so no key can arrive present-but-undefined and blank a field the summary had.
   */
  const record: BlogStateFacts = { ...blog, ...reviewState };
  const state = blogState(record);

  /**
   * THE BRAND'S BLOG DESTINATION, which two publish clauses read and neither can guess.
   *
   * It is a BRAND fact on a TOPIC's gate input, which is why it rides on gateInput below rather
   * than in `record`: blogState answers where the ARTICLE sits and has no use for it, while the
   * gate answers whether the record will take a publish and has two questions that turn on it.
   *
   * `undefined` while the brand list loads is the honest value and fails closed: both clauses
   * answer `unknowable`, the Post control is withheld, and it appears once the read lands. A
   * page that cannot say where a brand publishes must not offer to publish there.
   */
  const { activeClient } = useClients();
  const destination = activeClient?.site_kind;

  /**
   * WHAT THE STATE PERMITS. This replaces a single `blog.status === "done"` flag that governed
   * everything, and the reason it had to go is that `done` is not a place: it was equally true of
   * an article on the refining bench, one the client is reading right now, one they have approved,
   * and one already in the CMS. Those are four situations with four different sets of doors, so
   * one flag over all of them offered an edit that rewrote bytes somebody was mid-review of.
   *
   * THE GATE CONTRACT IS THE DISCRIMINATING LAYER, AND IT IS NOT A PREDICATE THIS FILE OR
   * blog-state.ts WRITES. It evaluates gate-contract.ts's clauses, each of which carries the
   * verbatim source line that performs the refusal, and dashboard/tests/gate-contract.test.ts
   * re-derives those lines and a fingerprint of every gating function from the migrations,
   * server/app.py, server/cms/gate.py and server/blog_edit.py on every run. Change a gate in SQL
   * and touch no TypeScript and that suite goes red. Five earlier rounds of this defect were each
   * a hand-written restatement of one of those rules, and each was silent when it was wrong, which
   * is why the restatement itself had to go rather than its contents.
   *
   * THE RECORD IS PASSED, NOT THE STATE, on purpose and unavoidably. The status is exactly the
   * fact the state folds away, so handing the contract the record is the only way to get it back,
   * and reaching for `state` here would reproduce the bug one line lower down.
   *
   * THE COMMENT RAIL IS FETCHED BEFORE ANY OF THESE FLAGS NOW, and that order is forced rather
   * than stylistic. Two refusals turn on how many changes are mid-apply: migration 010's
   * admin_save_blog_content raises PORTAL:APPLYING on the save, and the engine's comment route
   * raises at blog_edit.MAX_IN_FLIGHT. Both belong in the gate, the gate needs the count, and the
   * count comes from the rail, so the rail cannot wait on a flag the gate produces.
   */
  const commentsVisible = commentRailVisible(state);
  // Read once per visit, then watched only while an apply this operator started is settling.
  // A client's suggestion arriving is NOT watched for: it lands in the bell at the next read
  // of the blogs library, which is what a refresh is for.
  const comments = useBlogComments(brandSlug, topicSlug, commentsVisible);
  // The header tag's comment split follows the LIVE rail once it has landed, because this page
  // is where resolving happens and the count the row arrived with is stale by the first resolve.
  // Same fold as both wires: top-level client comments still open, applying or failed. Until the
  // rail lands, the row's own count keeps the tag honest instead of flickering through the
  // resolved face.
  const commentsPending =
    comments.comments !== null
      ? comments.comments.filter(
          (comment) =>
            comment.author === "client" &&
            (comment.state === "open" ||
              comment.state === "applying" ||
              comment.state === "failed"),
        ).length
      : (blog.comments_pending ?? null);
  /**
   * HOW MANY CHANGES ARE MID-APPLY, or "unread" when nobody has told this page yet.
   *
   * THE THREE OUTCOMES ARE THE FORM'S THREE, for the same reason. A rail that has not landed, or
   * that came back an error, is not a fact about anything, and a page that cannot say how many
   * applies are running must not claim there are none: the contract answers `unknowable` and the
   * control is withheld until the read lands. A rail nobody is fetching, because this state has no
   * conversation to show, is a real zero: `commentsVisible` is false exactly where no client
   * suggestion can exist and no operator apply is in flight.
   *
   * COMPUTED PLAINLY, BECAUSE THE MEMO THAT USED TO WRAP IT COST THIS FILE EVERY OTHER MEMO. It
   * listed `commentsVisible` among its dependencies, React Compiler could not prove that value
   * stable across renders, and the rule it failed is preserve-manual-memoization, whose
   * consequence is not a lost memo but a SKIPPED COMPILATION of the entire component. So the one
   * memoization written by hand here was bought at the price of every memoization the compiler
   * would have written for the rest of this file, while every sibling component kept theirs.
   *
   * THE TRADE IS NOT CLOSE. What this expression does is two comparisons and one filter over a
   * list this page is already holding in memory, so recomputing it on every render costs nothing
   * measurable, and the compiler memoizes it for us anyway once it is permitted to run over the
   * component at all. A hand rolled memo is worth keeping where it guards real work; this one
   * guarded a filter and disabled an optimiser.
   */
  const applyingFact: GateApplying = !commentsVisible
    ? 0
    : comments.error !== null || comments.checking
      ? "unread"
      : comments.comments.filter((comment) => comment.state === "applying").length;
  const applying = applyingFact === "unread" ? 0 : applyingFact;

  // `record`, NEVER `blog`. See the comment on `record` above: handing the gate the summary while
  // the state machine reads the merge is the seam that put a Send button over an article whose
  // client had just filed a suggestion, and took one away from an article whose suggestions were
  // all resolved. The two must be asked about the same version of the same blog.
  // `destination` spreads onto the record HERE rather than into `record` above, because it is a
  // brand fact and blogState must not see it: the bench answers where the ARTICLE sits, and the
  // gate answers whether the record will take the act.
  const gateRecord = { ...record, destination };
  const gateInput: GateInput = { record: gateRecord, form: questionForm, applying: applyingFact };
  /**
   * EDIT IS A STANDING RATHER THAN A BOOLEAN, and the difference is the greyed button.
   *
   * This file's rule is that a control refused by the STATE is gone rather than greyed, with a
   * stated exception for conditions that clear on their own, an apply already in flight among
   * them. That exception used to be implemented HERE, as a hand written `applying > 0` on the
   * button's disabled prop, sitting under a canEdit that knew nothing about the refusal it was
   * restating. The contract now carries which of its clauses are transient, so the page reads the
   * shape of the control off the layer that performs the refusal instead of deciding it alone.
   */
  const editStanding = adminGateStanding("edit", gateInput);
  const canEdit = !HOSTED_READONLY && adminCan(state, "edit") && editStanding.mount;
  /**
   * NO HOSTED_READONLY TERM HERE, DELIBERATELY, and canEdit above carries one. The write half of
   * this axis is canRunClaude below, which is what the composer and the resolve doors are gated
   * on, and an admin on the hosted build must still be able to read what the client asked for.
   */
  const commentStanding = adminGateStanding("comments", gateInput);
  const canComment = adminCan(state, "comments") && commentStanding.mount;
  /**
   * SEND AND PUBLISH CARRY THE CONTRACT TERM NOW, and their not carrying one was its own round of
   * this defect. The binding test in gate-contract.test.ts iterated three of the six acts, so
   * these two were free to keep private opinions and did: the send's real refusals live in
   * migration 009's admin_send_blog_to_client and server/app.py's send route, and the publish's
   * live in server/cms/gate.py, which refuses any push whose terminal status is not exactly
   * "done". The contract was declaring `publish` unconditional at the time.
   *
   * BOTH ARE GONE RATHER THAN GREYED, which is what `mount` answers here: every clause behind them
   * is permanent, so there is nothing to wait out. The child components keep their own reason
   * sentences for the operator, and those sentences are now downstream of a decision made here.
   */
  /**
   * ONE RELEASE DOOR FOR EVERY BAND, and the second one is deleted rather than moved. `send`
   * is now granted on the failed bench too, and the send door absorbed the two clauses that
   * were the promote door's alone: no live run, and an evaluator-scored draft on the wire. So
   * a below-bar blog is refused here for the same reasons it always was, and a mid-retry
   * topic whose stale `failed` fold is still on the wire stays refused while its run is live.
   * HOSTED_READONLY needs no term: SendToClient returns null on that build, and unlike the
   * promote route the send route genuinely exists there for the done blogs that reach it.
   */
  const canSend = adminCan(state, "send") && adminGateAllows("send", gateInput);
  const canPublish = adminCan(state, "publish") && adminGateAllows("publish", gateInput);
  /**
   * THE `answer` VERB IS TWO DOORS AND BOTH GATE ON THE FORM, NEVER ON THE STATUS. Rounds four and
   * five of one defect were both this flag, and the second one is why nothing here restates a rule
   * any more.
   *
   * Round four believed AnswerQuestions discriminated on its own by finding no form once the
   * revise's finally-arm cleared it. The panel reads the RECORD rather than the disk, server/sync.py
   * spares answered evaluator rows from the post-revise delete, and questions-state.ts modeOf tests
   * `answered` before `stale`, so an answered stale form took the answered branch and drew "Rerun
   * with their answers" over a form server/app.py:1538 refuses. Round five moved the decision here
   * and derived it from `status === "needs_review"`, off a stated biconditional between that status
   * and a current answerable form. revise_topic's three restore arms append a terminal line
   * carrying `prev_terminal["status"]` without passing it through _enforce_terminal_status, so a
   * spent or stale form sits beside that status routinely and the biconditional is false.
   *
   * SO THE PAGE ASKS THE FORM, WHICH IT WAS ALREADY HOLDING. `stale` and `answered` are the two
   * fields POST /answers and POST /revise actually read, GET blogQuestions has always returned
   * them, and useBlogQuestions above already fetched them for this topic. The fact was on the wire
   * the whole time and every round so far reached for a proxy instead of it.
   *
   * AN UNREAD FORM WITHHOLDS THE CONTROL RATHER THAN GUESSING IT. `questionForm` is "unread" until
   * the read lands, the contract answers `unknowable`, and `adminGateAllows` fails closed. Every
   * previous round failed OPEN, and a control absent for the moment a read is in flight is a
   * smaller harm than one that argues with the record.
   *
   * THE !HOSTED_READONLY TERM IS THE DEPLOYMENT AXIS, which is a different question from the record
   * axis the contract answers and cannot be folded into it. There is no hosted answers route and no
   * hosted revise route at all, so on that build both doors lead nowhere.
   */
  const canAnswer =
    !HOSTED_READONLY &&
    adminCan(state, "answer") &&
    adminGateAllows("answer", gateInput);
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
   * The draft the editor is actually holding, and null the moment the state stops permitting an
   * edit. A client approving while this page sits open locks the article for everyone, this side
   * included, so a textarea left standing over that promises a save the engine refuses. Dropping
   * back to the read view says so by construction, and the tag beside the title says why.
   */
  const editorDraft = canEdit ? editDraft : null;

  // Announce each comment that settles, once, and re-read the article it changed. The ref
  // carries the states already seen, so a poll that returns the same settled comment twice
  // cannot toast twice.
  const seenStates = React.useRef(new Map<string, BlogComment["state"]>());
  const articleReload = article.reload;

  /**
   * UNDO / REDO over the article's COMMITTED states, held in browser memory only.
   *
   * Every committed change on this page already lands in the record the instant it happens
   * (a manual save, a Claude apply, and now an undo or a redo), so the database always holds
   * exactly the state on screen and leaving the page loses nothing. These stacks are this
   * VISIT's memory of the states it walked through; a refresh deliberately forgets them,
   * which is the contract: the record keeps the current state, the browser keeps the trail.
   *
   * An undo is a NEW SAVE of the previous state, through the same route an edit uses, never
   * a rollback: the record stays append-only (a fresh blog_versions row), and the approved /
   * with-client / apply-in-flight gates all still apply to it.
   */
  const historyRef = React.useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const lastTextRef = React.useRef<string | null>(null);
  const timeTravelRef = React.useRef(false);
  // The stacks live in a ref (the articleText effect pushes to them without a stale closure),
  // but the Undo/Redo buttons need their LENGTHS at render time. Reading historyRef.current in
  // render is a bug the linter rightly flags, so mirror the counts into reducer state and sync
  // it wherever the ref changes. A useReducer dispatch inside an effect is fine; a ref read in
  // render is not.
  const [historyCounts, syncHistoryCounts] = React.useReducer(
    (_prev: { past: number; future: number }, next: { past: number; future: number }) => next,
    { past: 0, future: 0 },
  );
  const [travelling, setTravelling] = React.useState(false);

  React.useEffect(() => {
    // A different topic is a different history.
    historyRef.current = { past: [], future: [] };
    lastTextRef.current = null;
    timeTravelRef.current = false;
    syncHistoryCounts({ past: 0, future: 0 });
  }, [topicSlug]);

  React.useEffect(() => {
    if (articleText === null) {
      return;
    }
    const last = lastTextRef.current;
    lastTextRef.current = articleText;
    if (last === null || last === articleText) {
      return;
    }
    if (timeTravelRef.current) {
      // This transition IS an undo/redo landing; the click already adjusted the stacks.
      timeTravelRef.current = false;
      return;
    }
    // A new committed state arrived (a save or a Claude apply): the old one becomes
    // undoable and any redo line is abandoned, exactly as an editor's history behaves.
    historyRef.current.past.push(last);
    historyRef.current.future = [];
    syncHistoryCounts({
      past: historyRef.current.past.length,
      future: historyRef.current.future.length,
    });
  }, [articleText]);

  const travel = React.useCallback(
    async (direction: "undo" | "redo") => {
      const h = historyRef.current;
      const from = direction === "undo" ? h.past : h.future;
      const to = direction === "undo" ? h.future : h.past;
      const target = from[from.length - 1];
      const current = lastTextRef.current;
      if (target === undefined || current === null) {
        return;
      }
      setTravelling(true);
      try {
        // Persisted BEFORE the stacks move, so a refused save (approved mid-flight, an apply
        // racing) leaves the history exactly as it was and the engine's reason is shown.
        await api.saveBlogContent(brandSlug, topicSlug, target, blog.version_no ?? null);
        from.pop();
        to.push(current);
        timeTravelRef.current = true;
        syncHistoryCounts({
          past: historyRef.current.past.length,
          future: historyRef.current.future.length,
        });
        articleReload();
        onChanged();
      } catch (cause) {
        toast.error(direction === "undo" ? "Could not undo" : "Could not redo", {
          description: cause instanceof ApiError ? cause.message : String(cause),
        });
      } finally {
        setTravelling(false);
      }
    },
    [brandSlug, topicSlug, blog.version_no, articleReload, onChanged],
  );
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
   * Reframes one comment as a standing instruction for every future blog and appends it to
   * the brand's custom instructions. The ENGINE owns the reframe (a one-shot Claude call) and
   * the append, so two operators clicking at once cannot lose each other's line; this side
   * only refreshes the rail, whose stamp is what flips the button to "Added to instructions".
   * The refusal is rethrown for the card to render beside the button that caused it.
   */
  async function addToInstructions(comment: BlogComment) {
    try {
      const updated = await api.commentToInstructions(brandSlug, topicSlug, comment.id);
      toast.success("Added to brand instructions", {
        description: updated.instruction,
      });
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

      {/* Title on top, then ONE action row beneath it. The buttons used to sit to the RIGHT of
          the title (justify-between); they now stack below it so every act, Post to CMS, Send
          and Retry, lives in a single row the operator scans left to right. */}
      <div>
        <div className="min-w-0">
          <h2 className="text-xl leading-snug font-semibold tracking-tight text-pretty text-foreground">
            {label !== null ? (
              <span
                className="machine mr-1.5 font-normal text-muted-foreground"
                title={blog.uploaded ? "Uploaded by hand: letters mark manual blogs" : "Written by the engine"}
              >
                {label}.
              </span>
            ) : null}
            {/* The title is editable in every SETTLED state (a label is not the article bytes),
                so this is gated on the deployment axis AND on generating: the hosted read-only
                build has no title route, and a still-generating blog has no topics row yet
                (it is committed at run terminal), so a rename would 404. Both show plain text.
                onChanged re-reads the summary so the new title lands in this h2 the moment it
                saves. */}
            {HOSTED_READONLY || state === "generating" ? (
              blog.topic
            ) : (
              <TitleEditor
                brandSlug={brandSlug}
                topicSlug={topicSlug}
                topic={blog.topic}
                onChanged={onChanged}
              />
            )}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {/* WHERE THE ARTICLE IS, which is not the same fact as how the run ended.
                StatusBadge read "shipped" for a blog on the bench, one the client was mid
                review of, one they had already approved and one sitting in the CMS. Those
                are four situations offering four different sets of controls on this very
                page, so the badge was contradicting the buttons under it. The tag names the
                one state this blog is in, and its tooltip names who owes the next act, which
                is the sentence that explains every control this page then declines to show. */}
            <BlogStateTag
              state={state}
              audience="admin"
              commentsPending={commentsPending}
              failedTag={adminFailedTag(blog.score ?? null)}
            />
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Left of the button that produces it, matching how SendToClient puts its own
              state chip beside its own control. It renders on the hosted build too, where
              PublishAction is absent: the record of a push is worth reading even where the
              push itself cannot be made. */}
          <PublishedChip
            published={reviewState.published}
            cmsStatus={reviewState.cms_status}
            url={reviewState.cms_url ?? null}
            destination={reviewState.published_to ?? null}
          />
          {/* GONE RATHER THAN GREYED wherever the state refuses them, both of these.

              A disabled Post to CMS on an article the client has not approved yet, or a
              disabled Send on one they are reading right now, is a control an operator has to
              read and reject on every single visit, and the first thing they do about it is go
              hunting for the switch that turns it on. There is no switch: the answer is the
              state, and the tag beside the title already carries it in words. An absent control
              next to an explained state is legible; a dead control next to it is a puzzle.

              THE DISABLED PATTERN SURVIVES INSIDE these components, and only for the reasons
              that clear on their own: a Claude apply already in flight, the engine's
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
              score={blog.score ?? null}
              // The BRAND's current destination, not the article's published_to: this decides
              // where a press would send it, and the chip beside it reports where a past push
              // actually went. Those differ the moment a brand is moved from the CMS to its
              // own website, and conflating them would label the button with history.
              destination={destination}
              onPublished={() => {
                // THE PUSH MOVES THE STATE NOW, so it has to move this page the way a send
                // does. `published` used to require a send stamp as well, which meant a push
                // changed no state and needed no refresh; it is the whole state on its own
                // today, so without this the operator posts, reads the same tag and the same
                // buttons, and posts again.
                //
                // RE-READ RATHER THAN A LOCAL FLIP, and that is the difference from onSent
                // above. The send POST answers with the review state it produced, so that
                // callback can spread a real record; the publish POST answers with the CMS's
                // own shape (post id, slug, draft status) and carries no published_at at all.
                // Synthesising a timestamp here would put this browser's clock on the record
                // and hand PublishedChip a stamp the database never wrote.
                void loadReview();
                onChanged();
              }}
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
              score={blog.score ?? null}
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
          {/* THE BELOW-BAR BLOG'S EXTRA AFFORDANCE, and Send above is the other one. A retry
              is a new RUN and runs start in the Create tab, so this is a LINK there with the
              row pre-ticked rather than a second, thinner copy of run submission on this page.
              It mounts on the state alone, because a retry is always available to a failed
              topic (the roadmap keeps its row selectable) including the scoreless failure the
              send door refuses, which is exactly the record whose only exit this is.

              `died` IS THE SECOND STATE HERE AND IT IS THE ONE THAT NEEDS IT MOST. A run that
              reached no verdict has no ship door at all (adminActions grants it neither send nor
              publish, because there is no judgement to overrule), so this link is not an extra
              affordance there, it is the ONLY exit. Omitting it would leave the exact dead end
              with no door that the failed row's own comment above is about. */}
          {(state === "failed" || state === "died") && !HOSTED_READONLY ? (
            <Button size="sm" variant="outline" asChild>
              <Link
                href={`${brandHref(orgSlug, brandSlug, "/create")}?retry=${encodeURIComponent(topicSlug)}`}
              >
                <RotateCw data-icon="inline-start" aria-hidden />
                Retry this topic
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {/* THE HOSTED BUILD OWES THE OPERATOR THIS SENTENCE, and until now it said nothing at all.
          Every admin write route on this build answers 501 hostedWriteRefused, and every control
          is REMOVED rather than greyed: SendToClient returns null, PublishAction returns null,
          canEdit and canAnswer carry !HOSTED_READONLY terms, and canRunClaude gates the composer
          and the resolve doors. That is the right shape for a control, and it leaves the page
          mute. The sentence below already promised canAnswer's term before canAnswer had one:
          it names answering the evaluator as an act that lives on the operator's own machine,
          while the panel rendered here regardless.

          MUTE IS NOT NEUTRAL, because the tag beside the title is still ISSUING AN INSTRUCTION.
          ADMIN_TAGS says this article is on your bench to refine and send, the operator reads it,
          finds no bench, and goes hunting for the switch that turns one on. There is no switch:
          the acts live in the app on their own machine. A bench that is honest locally and silent
          hosted is still dishonest, so the page says where the acts went.

          KEYED ON THE BENCH BEING NON-EMPTY rather than on a list of states, so it appears exactly
          where something was withheld and stays away from `generating`, `failed`, `stopped` and
          `unknown`, which offer nothing on either build and would be told they are missing acts
          they never had. */}
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
                  over it would be an invitation to look for a way in.

                  BOTH HALVES COME FROM THE CONTRACT NOW. `canEdit` above is its `mount`, and
                  this is its `act`: the disabled term used to read `applying > 0`, which is this
                  page restating migration 010's PORTAL:APPLYING condition in its own words one
                  layer below a canEdit that knew nothing about it. A restatement is silent when
                  it is wrong, which is every round of this defect, so the condition is read off
                  the clause and the sentence beside it is the layer's own reason. */}
              {/* Undo/redo over committed states, mounted with the Edit button and gated the
                  same way: each press writes a version through the save route, so the same
                  state permission and the same apply-in-flight moment govern it. */}
              {canEdit && tab === "blog.md" && editorDraft === null ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={historyCounts.past === 0 || travelling || !editStanding.act}
                    onClick={() => void travel("undo")}
                    aria-label="Undo the last change to the article"
                  >
                    <Undo2 data-icon="inline-start" aria-hidden />
                    Undo
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={historyCounts.future === 0 || travelling || !editStanding.act}
                    onClick={() => void travel("redo")}
                    aria-label="Redo the undone change to the article"
                  >
                    <Redo2 data-icon="inline-start" aria-hidden />
                    Redo
                  </Button>
                </>
              ) : null}
              {canEdit && tab === "blog.md" && editorDraft === null ? (
                <EditButton
                  disabled={articleText === null || !editStanding.act}
                  reason={
                    editStanding.waitingOn === null
                      ? null
                      : "A Claude change is being applied. Edit once it lands, so the two writes " +
                        "cannot race."
                  }
                  onClick={() => setEditDraft(articleText)}
                />
              ) : null}
              {/* Hidden while the blog tab is being edited: these export the SAVED
                  article, and offering them beside an unsaved draft exports stale text
                  the operator just rewrote. */}
              {editorDraft !== null && tab === "blog.md" ? null : (
                <MarkdownActions
                  raw={raw}
                  filename={tab === "blog.md" ? `${topicSlug}.md` : `${topicSlug}-${tab}`}
                  what={tab}
                />
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
                      /* The deployment axis alone: the reframe is a Claude call the hosted
                         build cannot make, and the ARTICLE's state never gates it, because
                         adding a standing instruction writes the brand record, not this
                         article. */
                      canAddToInstructions={!HOSTED_READONLY}
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
                      onAddToInstructions={addToInstructions}
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

/**
 * The blog's title, inline-editable. A pencil beside it opens a field with a tick (save) and an X
 * (cancel). The tick is enabled ONLY when the trimmed value is non-empty AND differs from the
 * current title, so a no-op save is impossible from both the button and Enter. Save writes
 * topics.title via api.setBlogTitle, then onChanged() re-reads the summary exactly like every
 * other write on this page, so the new title lands in the h2; a failure keeps the field open with
 * the typed value and toasts why. Enter saves, Escape cancels. No effect syncs `value` to the
 * prop: the field is seeded fresh on each open and StageBody is keyed by topic, so there is
 * nothing to reconcile.
 */
function TitleEditor({
  brandSlug,
  topicSlug,
  topic,
  onChanged,
}: {
  brandSlug: string;
  topicSlug: string;
  topic: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(topic);
  const [saving, setSaving] = React.useState(false);

  const trimmed = value.trim();
  const dirty = trimmed !== "" && trimmed !== topic;

  async function save() {
    if (!dirty || saving) return; // never POST an unchanged or blank title
    setSaving(true);
    try {
      await api.setBlogTitle(brandSlug, topicSlug, trimmed);
      setEditing(false);
      onChanged();
    } catch (cause) {
      toast.error("Could not rename this blog", {
        description: cause instanceof ApiError ? cause.message : String(cause),
      });
      // Stay in edit mode so the typed value is not lost on failure.
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <span className="inline-flex items-center gap-1.5 align-middle">
        <Input
          autoFocus
          value={value}
          // NOT disabled during save: disabling blurs the focused field, and on a failed save
          // the operator would lose their cursor. save() already guards on `saving`, so Enter
          // cannot double-submit; only the buttons grey out.
          aria-label="Blog title"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
          className="h-8 w-[32ch] max-w-full text-base font-semibold"
        />
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => void save()}
          aria-label="Save title"
        >
          <Check aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={saving}
          onClick={() => setEditing(false)}
          aria-label="Cancel rename"
        >
          <X aria-hidden />
        </Button>
      </span>
    );
  }

  return (
    <>
      {topic}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            className="ml-1.5 align-middle text-muted-foreground"
            onClick={() => {
              setValue(topic);
              setEditing(true);
            }}
            aria-label="Rename this blog"
          >
            <Pencil aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Rename</TooltipContent>
      </Tooltip>
    </>
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
  canAddToInstructions,
  deploymentLocked,
  remaining,
  comments,
  onSubmit,
  onDismiss,
  onResolve,
  onAddToInstructions,
}: {
  loaded: LoadedArtifact | undefined;
  /** Whether the STATE lets this side file, resolve or dismiss a change. */
  canComment: boolean;
  /** Whether an engine is behind this page, so a Claude session can actually run. Threaded
   *  from StageBody rather than read off HOSTED_READONLY down here, so the one flag that
   *  already knows the answer is the only thing the rail can disagree with. */
  canResolve: boolean;
  /** Whether Add to brand instructions may run: the deployment axis alone, since the act
   *  writes the brand record rather than this article. */
  canAddToInstructions: boolean;
  /** Whether the read-only rail is read-only because of the DEPLOYMENT rather than the state.
   *  It decides which sentence a card owed an act prints, and the two are not interchangeable:
   *  one names a state that will change, the other names a build that will not. */
  deploymentLocked: boolean;
  remaining: number;
  comments: BlogComment[];
  onSubmit: (draft: SelectionDraft) => Promise<void>;
  onDismiss: (comment: BlogComment) => void;
  onResolve: (comment: BlogComment) => void;
  onAddToInstructions: (comment: BlogComment) => Promise<void>;
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
        canAddToInstructions={canAddToInstructions}
        deploymentLocked={deploymentLocked}
        remaining={remaining}
        onSubmit={onSubmit}
        onDismiss={onDismiss}
        onResolve={onResolve}
        onAddToInstructions={onAddToInstructions}
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
  // A PUBLISHED article's send stamp is PLUMBING, and saying "Sent for client review" over it
  // reports an act the operator did not choose. Post to CMS stamps the send so the portal has a
  // pinned version to serve (servedVersion reads it for `published`), which is the only reason
  // the timestamp exists on this path: posting is a RELEASE, and the client sees it under Posted,
  // never under Ready to post. Both chips rendered together and read as two different decisions.
  //
  // AN APPROVAL STILL SHOWS, published or not, and that is the whole of the exception: approval
  // is a real act by a real person and it is not superseded by our pushing the article. What is
  // suppressed is only the un-approved send line, whose story PublishedChip already tells better.
  if (review.client_approved === null && review.published !== null) {
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
          {approved ? "Approved" : "Sent for client review"} {formatRelative(when)}
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
  url,
  destination,
}: {
  published: string | null;
  cmsStatus: string | null;
  /** The article's own URL where it was published, or null when nothing recorded one. */
  url: string | null;
  /** "strategi-cms", or a host like "acme.com". Null on everything published before 035. */
  destination: string | null;
}) {
  if (published === null) {
    return null;
  }
  // TWO DESTINATIONS AND THEY MEAN OPPOSITE THINGS BY A PUSH. The CMS receives a DRAFT, so the
  // push is not the publication and the chip has always said so; an editor of ours decides
  // afterwards, and cms_status flipping to "published" is that decision landing. A client's own
  // website receives a LIVE article, because the publish door there opens only after the client
  // approved it, so the push IS the publication and there is no later step to wait for.
  //
  // Null destination is the pre-035 record, which can only have been a CMS push: the website
  // path did not exist to produce one.
  const toSite = Boolean(destination) && destination !== "strategi-cms";
  const live = toSite || cmsStatus === "published";
  const where = toSite ? destination : "CMS";
  return (
    <span className="inline-flex items-center gap-1.5">
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
            {toSite
              ? `Published on ${where}`
              : live
                ? "Live in the CMS"
                : "Posted to CMS"}{" "}
            {formatRelative(published)}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <span className="machine">{formatAbsolute(published)}</span>.{" "}
          {toSite
            ? `This article is live on ${where}. It went out on the client's own site, which is why it waited for their approval.`
            : live
              ? "The CMS reports this post as published, so an editor has already taken it live and posting again will not change it."
              : "This is the push, not the publication. An editor decides in the CMS whether the draft goes out."}
        </TooltipContent>
      </Tooltip>

      {/* THE LINK IS THE DESTINATION'S OWN, never one built from a slug: permalink structure is
          a per-site setting, so a derived URL is wrong on a good fraction of sites. Rendered
          only when the record actually holds one, which is every website push and no CMS push,
          so this never offers a link that goes nowhere. */}
      {url ? (
        <Button size="sm" variant="outline" asChild>
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLink data-icon="inline-start" aria-hidden />
            View on {where}
          </a>
        </Button>
      ) : null}
    </span>
  );
}

/**
 * The score, and how it got there. GET /blogs reports only the final number, so "89" alone
 * cannot tell an operator whether the draft landed there or climbed from 72 over three
 * iterations. The trail is read from the engine's own eval lines; a run with one iteration
 * has nothing to show and shows nothing.
 */
function ScoreTrail({ score, trail }: { score: number | null; trail: RunTrail | null }) {
  if (typeof score !== "number") {
    return <span className="text-xs text-muted-foreground">no score</span>;
  }
  const scores = trail?.scores ?? [];
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
      {/* Coloured by band, the same scoreClass the list uses: at or above 90 green because it
          shipped, BELOW_BAR_FLOOR to SHIP_BAR-1 amber, below it red, so the final score reads the same here as in
          the Blogs tab. */}
      <span className={cn("font-medium", scoreClass(score))}>{score}</span>
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

/** eval.md buries SCORE: NN in the body, and the score is the reason the operator opened
 *  this tab, so it gets lifted to the top. */
function EvalScore({ text }: { text: string }) {
  const score = extractScore(text);
  if (score === null) {
    return null;
  }
  // The COLOUR is read off scoreTone, so this sentence cannot name a band the colour beside it
  // disagrees with: this file used to recompute `score >= 95` locally, which is the exact
  // per-surface drift lib/blog-score.ts was extracted to end. One arm per tone, so the words and
  // the colour move together or not at all.
  const tone = scoreTone(score);
  return (
    <div className="mb-5 flex items-baseline gap-3 rounded-md border bg-muted/40 px-4 py-3">
      {/* Same band colours as the Blogs tab: at or above the bar green, the near miss amber,
          under it red. */}
      <span className={cn("machine text-3xl font-semibold", scoreClass(score))}>{score}</span>
      <span className="text-xs text-muted-foreground">
        {tone === "ship"
          ? `At or above ${SHIP_BAR}, the bar, so the evaluator passed this draft and the loop stopped there. A blog holding open questions waits for your answers whatever it scored.`
          : tone === "owed"
            ? `${BELOW_BAR_FLOOR} to ${SHIP_BAR - 1}: under the ${SHIP_BAR} bar, so the run failed just short of it. Retry it for the bar, or send it to the client once you have read it.`
            : `Under ${BELOW_BAR_FLOOR}, well short of the ${SHIP_BAR} bar. The loop revised it up to four times and never got close, so this one is worth a retry rather than a read.`}
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

"use client";

import { Check, Loader2, Send, Sparkles, Trash2, TriangleAlert, X } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import type { DiscoveryQuestion, DiscoverySet } from "@/types";

/**
 * The operator's discovery bench: generate, review, cut the weak ones, then send.
 *
 * THE REVIEW GATE IS THE POINT OF THIS SCREEN. Questions arrive from a model, and a model writing
 * straight to a client is the one thing every other outward-facing surface in this app refuses.
 * Until Send, portal_discovery_questions filters them out entirely, so a draft is not merely
 * unlabelled on the client's side, it is absent.
 *
 * NOTHING HERE HOLDS A BLOG. No article waits on these answers and no terminal status turns on
 * them. That is why there is no "N blogs blocked" banner and never should be: this bench improves
 * the fact base, and a brand that ignores it entirely ships exactly what it ships today.
 */

const POLL_MS = 4000;

export function DiscoveryBench({
  brandSlug,
  brandName,
}: {
  brandSlug: string;
  brandName: string;
}) {
  const [data, setData] = React.useState<DiscoverySet | null>(null);
  const [error, setError] = React.useState<string>("");
  const [busy, setBusy] = React.useState<string>("");

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await api.discovery(brandSlug, signal);
        if (signal?.aborted !== true) {
          setData(res);
          setError("");
        }
      } catch (cause) {
        if (signal?.aborted === true) return;
        setError(cause instanceof ApiError ? cause.message : String(cause));
      }
    },
    [brandSlug],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Poll ONLY while a generation is live. A settled bench is static, and polling it forever would
  // spend a request every four seconds on a screen nothing changes behind.
  const running = data?.job?.state === "running";
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [running, load]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      await fn();
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  if (data === null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" aria-busy>
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </div>
    );
  }

  const drafts = data.questions.filter((q) => q.sent_at === null);
  const sent = data.questions.filter((q) => q.sent_at !== null);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Questions for {brandName}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          What the crawl could not learn, asked of the person who knows. Answers land in the fact
          base every blog for this brand is written against.
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          These hold nothing. No blog waits on them, and a brand that never answers generates
          exactly as it does today.
        </p>
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Button
            size="sm"
            disabled={running || busy !== ""}
            onClick={() => void act("gen", () => api.generateDiscovery(brandSlug))}
          >
            {running ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {data.questions.length === 0 ? "Generate questions" : "Generate more"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={drafts.length === 0 || busy !== "" || running}
            onClick={() => void act("send", () => api.sendDiscovery(brandSlug))}
            title={
              drafts.length === 0
                ? "Nothing to send: every question has already been released"
                : `Release ${drafts.length} question(s) to ${brandName}'s portal`
            }
          >
            <Send className="size-4" aria-hidden />
            Send {drafts.length > 0 ? `${drafts.length} ` : ""}to client
          </Button>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {data.draft} draft · {data.sent} sent · {data.answered} answered
          </span>
        </CardContent>
      </Card>

      {/* THE REAL RUN COST, stated before the press and not after. Every other generate button in
          this app says the same thing, because none of them is free. */}
      <p className="text-xs text-muted-foreground">
        Generating runs one research session against {brandName}&apos;s live site and spends real
        Claude and Firecrawl credit.
      </p>

      {error !== "" ? (
        <Card className="border-amber-500/40">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            <span>{error}</span>
          </CardContent>
        </Card>
      ) : null}

      {data.job !== null ? <JobCard job={data.job} slug={brandSlug} onDone={load} /> : null}

      {drafts.length > 0 ? (
        <Section
          title="Drafts"
          hint="Only you can see these. Cut the weak ones, fix the wording, then send the set."
          questions={drafts}
          slug={brandSlug}
          busy={busy}
          onAct={act}
        />
      ) : null}

      {sent.length > 0 ? (
        <Section
          title="Sent"
          hint="Live in the client's portal. An answered question can no longer be edited or deleted."
          questions={sent}
          slug={brandSlug}
          busy={busy}
          onAct={act}
        />
      ) : null}

      {data.questions.length === 0 && data.job === null ? (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm font-medium">No questions yet</p>
            <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">
              Generate a set and Canon reads {brandName}&apos;s site for what it does not say:
              prices it never published, capacity it never listed, awards with no year on them.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function JobCard({
  job,
  slug,
  onDone,
}: {
  job: NonNullable<DiscoverySet["job"]>;
  slug: string;
  onDone: () => Promise<void>;
}) {
  if (job.state === "running") {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-4 text-sm">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span>Reading the site and writing questions. This takes a few minutes.</span>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className={job.state === "failed" ? "border-amber-500/40" : undefined}>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-start gap-2">
          {job.state === "failed" ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
          ) : (
            <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
          )}
          <p className="text-sm font-medium">
            {job.state === "failed"
              ? "The question generation failed"
              : `${job.landed} question${job.landed === 1 ? "" : "s"} landed as drafts`}
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void api.clearDiscoveryJob(slug).then(onDone)}
            aria-label="Dismiss this report"
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
        {/* THE AGENT'S PROSE REPORT IS DELIBERATELY NOT RENDERED. It runs to several hundred
            words and pushed the questions themselves below the fold, which inverted the screen:
            this is a review bench, and the thing being reviewed has to be the first thing on it.
            The report is still returned on the wire (DiscoveryJob.report) for anything that wants
            it; what changed is only that this card does not lead with it.

            A FAILURE still speaks, because a card that says only "it failed" is a dead end. */}
        {job.error !== "" ? <p className="text-sm text-amber-700">{job.error}</p> : null}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  hint,
  questions,
  slug,
  busy,
  onAct,
}: {
  title: string;
  hint: string;
  questions: DiscoveryQuestion[];
  slug: string;
  busy: string;
  onAct: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold tracking-tight">
          {title} <span className="tabular-nums text-muted-foreground">({questions.length})</span>
        </h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="space-y-2">
        {questions.map((q) => (
          <QuestionRow key={q.id} question={q} slug={slug} busy={busy} onAct={onAct} />
        ))}
      </div>
    </section>
  );
}

function QuestionRow({
  question,
  slug,
  busy,
  onAct,
}: {
  question: DiscoveryQuestion;
  slug: string;
  busy: string;
  onAct: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(question.question);
  const answered = question.answer !== null && question.answer !== "";

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            {editing ? (
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                className="text-sm"
                aria-label="Edit the question"
              />
            ) : (
              <p className="text-sm font-medium leading-snug">{question.question}</p>
            )}
            {question.why !== "" && !editing ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{question.why}</p>
            ) : null}
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {question.theme || "unlabelled"} · {question.kind}
            </p>
          </div>
          {/* An ANSWERED question offers no controls at all, rather than disabled ones. The
              client answered THOSE words: editing would make the record assert a pairing that
              never happened, and deleting would discard something a person actually wrote. */}
          {answered ? null : (
            <div className="flex shrink-0 gap-1">
              {editing ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== ""}
                    onClick={() =>
                      void onAct(question.id, async () => {
                        await api.editDiscoveryQuestion(slug, question.id, { question: text });
                        setEditing(false);
                      })
                    }
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setText(question.question);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== ""}
                    aria-label="Delete this question"
                    onClick={() =>
                      void onAct(question.id, () =>
                        api.deleteDiscoveryQuestion(slug, question.id),
                      )
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
        {answered ? (
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Answered{question.answered_by !== "" ? ` by ${question.answered_by}` : ""}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{question.answer}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

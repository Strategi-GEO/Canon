"use client";

import { Check, Loader2, TriangleAlert } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, detailText } from "@/portal/api";
import type { DiscoveryQuestion } from "@/portal/types";

/**
 * The client's discovery form: what our crawl could not learn about their brand.
 *
 * THREE THINGS MAKE THIS FORM DIFFERENT FROM THE EVALUATOR'S, and all three are deliberate.
 *
 * NOTHING IS REQUIRED. There is no submit button and no completeness check. The evaluator's form
 * demands every box because an unanswered question there strands an article forever; nothing here
 * holds anything, so demanding all forty would only produce an abandoned form. Six answers make
 * the fact base six facts better, and that is a real outcome rather than a partial failure.
 *
 * IT SAVES AS THEY TYPE. A form this long is answered over days, across sittings, probably by more
 * than one person. Anything that could lose their work to a closed tab would eventually lose it.
 *
 * IT IS GROUPED. Fifty questions in one column is a wall. Grouped by theme, with a count per
 * group, it reads as a series of small asks, and a client can answer the pricing ones today and
 * leave the credentials ones for whoever knows them.
 */

const SAVE_DEBOUNCE_MS = 700;

type SaveState = "idle" | "saving" | "saved" | "error";

export function QuestionsView({ brand }: { brand: string }) {
  const [questions, setQuestions] = React.useState<DiscoveryQuestion[] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    api
      .discovery(brand, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setQuestions(res.questions);
          setError(null);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause)));
      });
    return () => controller.abort();
  }, [brand, attempt]);

  if (error !== null) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="p-6 text-center">
          <p className="text-sm font-medium">Could not load your questions</p>
          <p className="mt-1 text-xs text-muted-foreground">{detailText(error)}</p>
          <Button className="mt-4" variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (questions === null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" aria-busy>
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only" role="status">
          Loading
        </span>
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="space-y-4">
        <Header answered={0} total={0} />
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-sm font-medium">No questions yet</p>
            <p className="mx-auto mt-2 max-w-prose text-sm text-muted-foreground">
              When our team has questions about your brand that your website does not answer, they
              appear here. Nothing is waiting on you right now.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Group by theme, preserving the order the server sent (kind, then sort_order). A Map keeps
  // insertion order, so the groups read in the same sequence the operator reviewed them in.
  const groups = new Map<string, DiscoveryQuestion[]>();
  for (const q of questions) {
    const label = q.theme.trim() === "" ? "About your brand" : q.theme.trim();
    const bucket = groups.get(label);
    if (bucket === undefined) groups.set(label, [q]);
    else bucket.push(q);
  }

  const answered = questions.filter((q) => q.answer !== null && q.answer !== "").length;

  return (
    <div className="space-y-6">
      <Header answered={answered} total={questions.length} />
      {[...groups.entries()].map(([theme, items]) => (
        <section key={theme} className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-semibold tracking-tight">{theme}</h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {items.filter((q) => q.answer !== null && q.answer !== "").length} of {items.length}
            </span>
          </div>
          <div className="space-y-3">
            {items.map((q) => (
              <QuestionCard key={q.id} brand={brand} question={q} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Header({ answered, total }: { answered: number; total: number }) {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold tracking-tight">Questions about your brand</h1>
      <p className="max-w-prose text-sm text-muted-foreground">
        These are things we could not learn from your website. Your answers go straight into the
        fact base every article for you is written against, so a claim you confirm here is one we
        can make with confidence later.
      </p>
      <p className="max-w-prose text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Answer what you can, skip what you cannot.</span>{" "}
        Nothing here is required and nothing is waiting on it. Your answers save as you type, so you
        can leave and come back.
      </p>
      {total > 0 ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          {answered} of {total} answered
        </p>
      ) : null}
    </div>
  );
}

function QuestionCard({ brand, question }: { brand: string; question: DiscoveryQuestion }) {
  const [value, setValue] = React.useState(question.answer ?? "");
  const [state, setState] = React.useState<SaveState>("idle");
  const [message, setMessage] = React.useState("");

  // The last value actually persisted. The debounce compares against this rather than against the
  // prop, so a re-render cannot make a saved answer look unsaved and re-send it.
  const savedRef = React.useRef(question.answer ?? "");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  function onChange(next: string) {
    setValue(next);
    setState("idle");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(next), SAVE_DEBOUNCE_MS);
  }

  async function save(next: string) {
    if (next === savedRef.current) return;
    setState("saving");
    try {
      await api.answerDiscovery(brand, question.id, next);
      savedRef.current = next;
      setState("saved");
      setMessage("");
    } catch (cause) {
      // Never clears the textarea. A failed save must leave what they typed on screen so they can
      // retry by typing a character, or copy it out. Wiping it would lose the answer twice.
      setState("error");
      setMessage(cause instanceof ApiError ? detailText(cause) : "Could not save that answer");
    }
  }

  // Blur flushes immediately rather than waiting out the debounce: a client who types and then
  // clicks away has finished with this box, and the pending timer is a window in which a closed
  // tab loses the answer.
  function onBlur() {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    void save(value);
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium leading-snug">{question.question}</p>
          {question.why !== "" ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{question.why}</p>
          ) : null}
        </div>
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          rows={2}
          placeholder="Your answer, or leave blank"
          aria-label={question.question}
          className="resize-y text-sm"
        />
        <div className="flex min-h-4 items-center gap-1.5 text-xs" aria-live="polite">
          {state === "saving" ? (
            <>
              <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">Saving</span>
            </>
          ) : null}
          {state === "saved" ? (
            <>
              <Check className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="text-muted-foreground">Saved</span>
            </>
          ) : null}
          {state === "error" ? (
            <>
              <TriangleAlert className="size-3 text-amber-600 dark:text-amber-500" aria-hidden />
              <span className="text-amber-700 dark:text-amber-400">{message}</span>
            </>
          ) : null}
          {state === "idle" && question.answered_at !== null && value === savedRef.current ? (
            <span className="text-muted-foreground">Answered</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

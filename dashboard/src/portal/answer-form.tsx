"use client";

import * as React from "react";
import { Loader2, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, detailText } from "@/portal/api";
import type { PortalQuestion } from "@/portal/types";

/**
 * The questionnaire, mirroring the admin dashboard's answer dialog question for question:
 * position number, area chip, the question as the label, the "why" in full, one textarea
 * each. Submit is all-or-nothing (the backend refuses partial forms), so the button stays
 * disabled until every answer is non-blank; the 422's blank ids are still handled, for
 * the case where a draft answer is whitespace.
 *
 * One difference from the admin form, and it is the spec: SUBMITTING FREEZES THE BLOG.
 * The confirmation line above the button says so before the client commits, and onSubmitted
 * flips the page to the frozen view.
 */
export function AnswerForm({
  brand,
  topic,
  questions,
  onSubmitted,
}: {
  brand: string;
  topic: string;
  questions: PortalQuestion[];
  onSubmitted: () => void;
}) {
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const complete = questions.every((question) => (drafts[question.id] ?? "").trim() !== "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.answer(brand, topic, {
        answers: questions.map((question) => ({
          id: question.id,
          answer: (drafts[question.id] ?? "").trim(),
        })),
      });
      onSubmitted();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // 409 means the record has moved past THIS form: someone already answered it
        // (another tab, or the team), or a new draft superseded it. The form on screen can
        // never succeed now, so an error message would strand the client on a dead form.
        // Reload instead: the page re-reads the record and renders what is actually true
        // (the frozen answers view, a fresh form, or the article sent for review).
        onSubmitted();
        return;
      }
      if (cause instanceof ApiError) {
        setError(detailText(cause));
      } else {
        setError(String(cause));
      }
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {questions.map((question, index) => (
        <div key={question.id} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">{index + 1}</span>
            {question.area !== null ? (
              <Badge variant="secondary" className="font-normal">
                {question.area}
              </Badge>
            ) : null}
          </div>
          <Label htmlFor={`answer-${question.id}`} className="leading-snug font-medium text-pretty">
            {question.question}
          </Label>
          {question.why !== "" ? (
            <p id={`why-${question.id}`} className="text-xs leading-relaxed text-muted-foreground">
              {question.why}
            </p>
          ) : null}
          <Textarea
            id={`answer-${question.id}`}
            rows={3}
            required
            value={drafts[question.id] ?? ""}
            onChange={(event) =>
              setDrafts((prev) => ({ ...prev, [question.id]: event.target.value }))
            }
            placeholder="Your answer"
            disabled={pending}
            aria-describedby={question.why !== "" ? `why-${question.id}` : undefined}
          />
        </div>
      ))}

      {error !== null ? (
        <p role="alert" className="rounded-md border border-fail/20 bg-fail-bg px-3 py-2 text-xs font-medium text-fail">
          {error}
        </p>
      ) : null}

      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Sending your answers hands this article back to our editorial team. You will see
          your answers here, and the article updates once the team has applied them.
        </p>
        <Button type="submit" disabled={!complete || pending} className="w-full">
          {pending ? (
            <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
          ) : (
            <Send data-icon="inline-start" aria-hidden />
          )}
          Send answers
        </Button>
      </div>
    </form>
  );
}

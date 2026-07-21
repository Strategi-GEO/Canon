"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The command that starts the engine, so no operator guesses at it. */
export const START_COMMAND =
  ".venv/bin/uvicorn server.app:app --port 8000";

/**
 * Flattens an ApiError body into the engine's own sentences.
 *
 * The engine answers a refusal with a real reason and that reason is the entire value of
 * the error: 400 sends a plain detail, 422 sends either a string or a per row missing
 * list, 413 sends a size complaint. Rewriting any of it into "something went wrong" would
 * strip the one thing that tells an operator what to fix.
 */
export function errorLines(error: ApiError): string[] {
  const detail = error.detail;

  if (typeof detail === "string" && detail.trim() !== "") {
    return [detail];
  }

  // The 409 arrives as {detail: {detail: "...", duplicates: [...]}}, so once api.ts unwraps
  // the outer detail there is a second one holding the engine's actual sentence. Reaching for
  // it is the difference between "2 selected row(s) already exist for demo: ... Deselect them
  // and resubmit." and a JSON dump of that same sentence wrapped in braces and array noise.
  // Reachable from this file today: a roadmap upload answers 409 while a run is live.
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const inner = (detail as { detail?: unknown }).detail;
    if (typeof inner === "string" && inner.trim() !== "") {
      return [inner];
    }
  }

  if (Array.isArray(detail)) {
    const lines = detail.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const row = entry as { index?: number; missing?: string[]; msg?: string };
      if (typeof row?.index === "number" && Array.isArray(row.missing)) {
        return `Row ${row.index} is missing: ${row.missing.join(", ")}`;
      }
      if (typeof row?.msg === "string") {
        return row.msg;
      }
      return JSON.stringify(entry);
    });
    if (lines.length > 0) {
      return lines;
    }
  }

  if (detail && typeof detail === "object") {
    return [JSON.stringify(detail)];
  }

  return [error.message];
}

/** One line of the engine's reason, for putting next to a field. */
export function FieldError({ error, className }: { error: ApiError; className?: string }) {
  return (
    <p
      className={cn("machine mt-1.5 text-xs wrap-break-word text-fail", className)}
      role="alert"
    >
      {errorLines(error).join(" ")}
    </p>
  );
}

/**
 * The engine can be down while the dashboard is up. Showing an empty client list then
 * would be a lie: it would read as "you have no clients" when it means "nothing answered".
 */
export function EngineDown({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <Card className="border-fail/25 bg-fail-bg">
      <CardContent className="py-8 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-fail/10">
          <TriangleAlert className="size-5 text-fail" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-fail">
          {error.isOffline ? "Cannot reach the engine" : "The engine refused the request"}
        </p>
        {errorLines(error).map((line, i) => (
          <p
            key={i}
            className="machine mx-auto mt-2 max-w-md text-xs wrap-break-word text-fail/80"
          >
            {line}
          </p>
        ))}
        {error.isOffline ? (
          <div className="mx-auto mt-5 max-w-md text-left">
            <p className="text-xs text-muted-foreground">Start it from the repo root:</p>
            <pre className="machine mt-1.5 overflow-x-auto rounded-md border border-border bg-card px-3 py-2 text-xs text-foreground">
              {START_COMMAND}
            </pre>
          </div>
        ) : null}
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

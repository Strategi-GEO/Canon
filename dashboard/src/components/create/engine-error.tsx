"use client";

import { TriangleAlert } from "lucide-react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { IncompleteRow } from "@/types";

/**
 * The engine answers a refusal with the reason: a duplicates array, a per-row missing list,
 * a plain detail string. That reason is the only thing that tells an operator what to do
 * next, so it is rendered as sent. There is no generic "something went wrong" in this page.
 */
export function detailText(error: ApiError): string {
  const { detail } = error;

  if (typeof detail === "string" && detail.trim() !== "") {
    return detail;
  }

  // The 409 arrives as {detail: {detail: "...", duplicates: [...]}}, so once api.ts unwraps
  // the outer detail there is a second one holding the engine's actual sentence. Reaching
  // for it is the difference between "2 selected row(s) already exist for demo: ...
  // Deselect them and resubmit." and a JSON dump of the same thing.
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const inner = (detail as { detail?: unknown }).detail;
    if (typeof inner === "string" && inner.trim() !== "") {
      return inner;
    }
  }

  if (Array.isArray(detail)) {
    const rows = detail as IncompleteRow[];
    const named = rows
      .filter((r) => typeof r?.index === "number" && Array.isArray(r?.missing))
      .map((r) => `row ${r.index + 1} is missing ${r.missing.join(", ")}`);
    if (named.length > 0) {
      return named.join("; ");
    }
  }

  if (detail && typeof detail === "object") {
    return JSON.stringify(detail);
  }

  return error.message;
}

/** An inline refusal, sat next to the control that caused it. */
export function EngineErrorNote({
  error,
  className,
}: {
  error: ApiError;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "flex items-start gap-1.5 text-xs text-fail wrap-break-word",
        className,
      )}
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        <span className="machine">{error.status > 0 ? `${error.status} ` : ""}</span>
        <span className="machine">{detailText(error)}</span>
      </span>
    </p>
  );
}

"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { EngineErrorNote } from "@/components/create/engine-error";
import { cn } from "@/lib/utils";
import type { RoadmapResponse } from "@/types";

/**
 * Uploads a roadmap CSV. The operator uploads a fresh sheet every run, so this stays
 * available even once a saved roadmap exists.
 *
 * Uploading is NOT committing. The engine archives the sheet, parses it, and hands back the
 * rows it read; nothing generates until the operator picks rows and presses Generate. So the
 * table that appears after an upload IS the preview, and it is the engine's own parse of the
 * file rather than a second parser in the browser that could disagree with it.
 *
 * Every refusal here is the engine's own sentence, rendered verbatim. A CSV with too few
 * columns comes back naming how many it found, which is the one fact that tells the operator
 * what to fix, and no wrapper text is allowed to replace it.
 */
export function RoadmapUploader({
  slug,
  label,
  variant = "outline",
  dropzone = false,
  onUploaded,
}: {
  slug: string;
  label: string;
  variant?: "default" | "outline";
  /** Renders the full drop target. The compact button still accepts drops on itself. */
  dropzone?: boolean;
  onUploaded: (roadmap: RoadmapResponse) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [over, setOver] = React.useState(false);
  // dragenter and dragleave fire for every child element the pointer crosses, so a boolean
  // set from them flickers. Counting entries against leaves is what makes the state hold.
  const depth = React.useRef(0);

  const upload = React.useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);

      // The engine is the authority on whether a sheet is usable, and it says so precisely.
      // This checks only the one thing it cannot: that a file was dropped at all, and that it
      // is not obviously the wrong kind. Anything subtler is left to the engine's own parse.
      if (!/\.csv$/i.test(file.name)) {
        setError(
          new ApiError(0, `${file.name} is not a .csv file. The roadmap has to be a CSV.`, null),
        );
        setBusy(false);
        return;
      }

      const form = new FormData();
      form.append("file", file);
      try {
        onUploaded(await api.uploadRoadmap(slug, form));
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
      } finally {
        setBusy(false);
        // Clearing lets the operator retry the same filename after fixing the sheet.
        if (inputRef.current) {
          inputRef.current.value = "";
        }
      }
    },
    [onUploaded, slug],
  );

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      void upload(file);
    }
  }

  function onDragOver(event: React.DragEvent) {
    // Without this the browser navigates to the file and the operator loses the page.
    event.preventDefault();
  }

  function onDragEnter(event: React.DragEvent) {
    event.preventDefault();
    depth.current += 1;
    setOver(true);
  }

  function onDragLeave() {
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setOver(false);
    }
  }

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept=".csv,text/csv"
      className="sr-only"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) {
          void upload(file);
        }
      }}
    />
  );

  if (!dropzone) {
    return (
      <div onDrop={onDrop} onDragOver={onDragOver} onDragEnter={onDragEnter} onDragLeave={onDragLeave}>
        {input}
        <Button
          type="button"
          variant={variant}
          size="sm"
          disabled={busy}
          className={cn(over && "border-primary text-primary")}
          onClick={() => inputRef.current?.click()}
        >
          <Upload aria-hidden data-icon="inline-start" />
          {busy ? "Uploading" : over ? "Drop the CSV" : label}
        </Button>
        {error ? <EngineErrorNote error={error} className="mt-2" /> : null}
      </div>
    );
  }

  return (
    <div className="w-full">
      {input}
      {/* A real button, not a div with a click handler: it is in the tab order, it answers
          Enter and Space, and a screen reader calls it a button, all for free. Dropping is an
          enhancement on top of it rather than the only way in. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        className={cn(
          "flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
          over ? "border-primary bg-primary/5" : "border-border hover:border-primary/40",
        )}
      >
        <Upload
          className={cn("size-4", over ? "text-primary" : "text-muted-foreground")}
          aria-hidden
        />
        <span className="text-sm font-medium text-foreground">
          {busy ? "Uploading" : over ? "Drop the CSV" : label}
        </span>
        <span className="text-xs text-muted-foreground">
          Drop a .csv here, or click to choose one.
        </span>
      </button>
      {error ? <EngineErrorNote error={error} className="mt-2" /> : null}
    </div>
  );
}

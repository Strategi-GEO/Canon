"use client";

import * as React from "react";
import { CheckCircle2, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Resource, ResourcesResponse } from "@/types";
import { errorLines, FieldError } from "@/components/clients/engine-error";
import { formatDate, formatSize, uploadedAt } from "@/components/clients/wire";

/** One file's outcome. No percentage: fetch reports no upload progress, so a bar would animate a guess. */
type UploadState = {
  name: string;
  status: "uploading" | "done" | "error";
  error: ApiError | null;
};

export function ResourcesPanel({ brandSlug }: { brandSlug: string }) {
  const [resources, setResources] = React.useState<Resource[] | null>(null);
  const [loadError, setLoadError] = React.useState<ApiError | null>(null);
  const [uploads, setUploads] = React.useState<UploadState[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<Resource | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const applyLoaded = React.useCallback((data: ResourcesResponse) => {
    setResources(data.resources);
    setLoadError(null);
  }, []);

  const applyFailed = React.useCallback((cause: unknown) => {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return;
    }
    setLoadError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    setResources([]);
  }, []);

  // State is written only from the settled callbacks: the engine is an external system,
  // and `resources` starts null, which is what the skeleton renders from.
  React.useEffect(() => {
    const controller = new AbortController();
    api.resources(brandSlug, controller.signal).then(applyLoaded, applyFailed);
    return () => controller.abort();
  }, [brandSlug, applyLoaded, applyFailed]);

  /** Called after an upload or a delete, both of which are event handlers. */
  const reload = React.useCallback(async () => {
    try {
      applyLoaded(await api.resources(brandSlug));
    } catch (cause) {
      applyFailed(cause);
    }
  }, [brandSlug, applyLoaded, applyFailed]);

  /**
   * Uploads run one at a time and each result is recorded on its own row. The engine
   * refuses a bad filename with 400 and an oversized file with 413, per file, so one
   * refusal must never cancel the files behind it: the operator drops a folder and needs
   * to know which of the eight landed.
   */
  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    setUploads(list.map((f) => ({ name: f.name, status: "uploading", error: null })));

    // Indexed, not keyed by name: two files dropped from different folders can share a
    // name, and matching on the name would report one file's 413 against the other.
    for (const [i, file] of list.entries()) {
      const form = new FormData();
      form.append("file", file);
      try {
        await api.uploadResource(brandSlug, form);
        setUploads((prev) =>
          prev.map((u, j) => (i === j ? { ...u, status: "done" } : u)),
        );
      } catch (cause) {
        const error =
          cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
        setUploads((prev) =>
          prev.map((u, j) => (i === j ? { ...u, status: "error", error } : u)),
        );
      }
    }

    await reload();
  }

  async function remove(resource: Resource) {
    try {
      await api.deleteResource(brandSlug, resource.name);
      toast.success(`Deleted ${resource.name}`);
      setPendingDelete(null);
      await reload();
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      toast.error(errorLines(error).join(" "));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-foreground">Resources</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Files uploaded here are read by the researcher before any external search, so this
          is how a client&apos;s own documents reach the blog.
        </p>
      </CardHeader>
      <CardContent>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border bg-muted/30",
          )}
        >
          <Upload className="mx-auto size-4 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-xs text-muted-foreground">
            Drop files here, or pick them yourself. 25 MB per file.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => inputRef.current?.click()}
          >
            Choose files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="sr-only"
            aria-label="Upload resources"
            onChange={(e) => {
              if (e.target.files) {
                void upload(e.target.files);
              }
              // Cleared so re-picking the same file after a 413 still fires a change event.
              e.target.value = "";
            }}
          />
        </div>

        {uploads.length > 0 ? (
          <ul className="mt-3 space-y-1.5" aria-live="polite">
            {uploads.map((item, i) => (
              <li key={`${item.name}:${i}`} className="rounded-md border px-2.5 py-2">
                <div className="flex items-center gap-2">
                  {item.status === "uploading" ? (
                    <Loader2
                      className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                      aria-hidden
                    />
                  ) : item.status === "done" ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-ship" aria-hidden />
                  ) : (
                    <Paperclip className="size-3.5 shrink-0 text-fail" aria-hidden />
                  )}
                  <span className="machine min-w-0 flex-1 truncate text-xs text-foreground">
                    {item.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.status === "uploading"
                      ? "uploading"
                      : item.status === "done"
                        ? "uploaded"
                        : "refused"}
                  </span>
                </div>
                {item.error ? <FieldError error={item.error} /> : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4">
          {loadError ? <FieldError error={loadError} /> : null}

          {resources === null ? (
            <div className="space-y-2">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : resources.length === 0 && !loadError ? (
            <p className="text-xs text-muted-foreground">
              No resources yet. The researcher will go straight to external sources.
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {resources.map((resource) => (
                <li
                  key={resource.name}
                  className="flex items-center gap-2 px-2.5 py-2"
                >
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="machine min-w-0 flex-1 truncate text-xs text-foreground">
                    {resource.name}
                  </span>
                  <span className="machine hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {formatSize(resource.size)}
                  </span>
                  <span className="machine hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {formatDate(uploadedAt(resource))}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete ${resource.name}`}
                    onClick={() => setPendingDelete(resource)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this resource?</DialogTitle>
            <DialogDescription>
              The researcher stops reading it on the next run. Blogs already written from it
              keep whatever they cited.
            </DialogDescription>
          </DialogHeader>
          <p className="machine text-xs wrap-break-word text-foreground">
            {pendingDelete?.name}
          </p>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (pendingDelete) {
                  void remove(pendingDelete);
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

"use client";

import * as React from "react";
import {
  CheckCircle2,
  Download,
  FileX2,
  Loader2,
  Paperclip,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { HOSTED_READONLY } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import type { Resource, ResourcesResponse } from "@/types";
import { errorLines, FieldError } from "@/components/clients/engine-error";
import { previewKind, resourceTypeLabel, type PreviewKind } from "@/components/clients/resource-type";
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
  const [previewing, setPreviewing] = React.useState<Resource | null>(null);
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

  /**
   * The ORIGINAL uploaded file, byte for byte: the engine streams it from content-addressed
   * Storage with ?download=1. Saved through a throwaway anchor because the fetch needs the
   * Authorization header, which a plain href cannot carry.
   */
  async function download(resource: Resource) {
    try {
      const blob = await api.resourceFile(brandSlug, resource.name, { download: true });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = resource.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
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
        {/* Uploading needs the engine (the record write plus the scratch copy agents read),
            so the hosted build lists the files and offers no way to change them. */}
        {HOSTED_READONLY ? null : (
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
        )}

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
                    // The refusal icon the rest of the app uses, never a tinted file icon:
                    // a red paperclip reads as a broken file, not a refused upload.
                    <TriangleAlert className="size-3.5 shrink-0 text-fail" aria-hidden />
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
                  className="flex items-center gap-2 px-2.5 py-2 transition-colors hover:bg-muted/40"
                >
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {/* Previewing streams bytes from the engine, so the hosted build shows a
                      plain name where the local build shows a preview trigger. */}
                  {HOSTED_READONLY ? (
                    <span className="machine min-w-0 flex-1 truncate text-xs text-foreground">
                      {resource.name}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPreviewing(resource)}
                      title={`Preview ${resource.name}`}
                      className="machine min-w-0 flex-1 truncate rounded-sm text-left text-xs text-foreground transition-colors hover:text-primary"
                    >
                      {resource.name}
                    </button>
                  )}
                  <Badge variant="secondary" className="machine shrink-0">
                    {resourceTypeLabel(resource)}
                  </Badge>
                  <span className="machine hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {formatDate(uploadedAt(resource))}
                  </span>
                  {/* Preview and download both need the engine; the hosted build only
                      reads the index, so it keeps the badge and drops the controls. */}
                  {HOSTED_READONLY ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Download ${resource.name}`}
                      title={`Download ${resource.name}`}
                      onClick={() => void download(resource)}
                    >
                      <Download aria-hidden />
                    </Button>
                  )}
                  {/* Deleting is an engine write; the hosted build only reads the index. */}
                  {HOSTED_READONLY ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${resource.name}`}
                      onClick={() => setPendingDelete(resource)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  )}
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

      <ResourcePreviewDialog
        brandSlug={brandSlug}
        resource={previewing}
        onClose={() => setPreviewing(null)}
        onDownload={(resource) => void download(resource)}
      />
    </Card>
  );
}

/**
 * What the preview fetch produced, stamped with the file it belongs to: state is written
 * ONLY from the settled fetch callbacks, and the render derives "loading" from the stamp
 * not matching the open file. The object URL is owned by the effect's cleanup.
 */
type PreviewData = {
  forName: string;
  status: "ready" | "error";
  url: string | null;
  text: string | null;
  error: ApiError | null;
};

/**
 * One file's bytes, fetched as a blob through the authenticated api helper: the engine
 * endpoint requires the Authorization header, so a plain <iframe src> could never load it.
 * PDFs render in an iframe, images in an img, text in a scrollable pre, and anything else
 * gets an honest "no in-browser preview" with the download as the way out.
 */
function ResourcePreviewDialog({
  brandSlug,
  resource,
  onClose,
  onDownload,
}: {
  brandSlug: string;
  resource: Resource | null;
  onClose: () => void;
  onDownload: (resource: Resource) => void;
}) {
  const [fetched, setFetched] = React.useState<PreviewData | null>(null);
  const kind: PreviewKind = resource ? previewKind(resource) : "none";

  // The fetch lives and dies with the dialog: closing aborts an in-flight request, and the
  // cleanup revokes the object URL so a session of previews never leaks blob memory. The
  // "none" kind fetches nothing, because there is nothing this dialog could do with it.
  React.useEffect(() => {
    if (!resource || previewKind(resource) === "none") {
      return;
    }
    const wantKind = previewKind(resource);
    const name = resource.name;

    let objectUrl: string | null = null;
    const controller = new AbortController();
    api.resourceFile(brandSlug, name, { signal: controller.signal }).then(
      async (blob) => {
        if (wantKind === "text") {
          const text = await blob.text();
          setFetched({ forName: name, status: "ready", url: null, text, error: null });
        } else {
          objectUrl = URL.createObjectURL(blob);
          setFetched({ forName: name, status: "ready", url: objectUrl, text: null, error: null });
        }
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
        setFetched({ forName: name, status: "error", url: null, text: null, error });
      },
    );

    return () => {
      controller.abort();
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [brandSlug, resource]);

  // Data for THIS file only. A stamp from an earlier preview means the fetch is still in
  // flight, which the render below reads as loading rather than showing stale bytes.
  const data = resource !== null && fetched?.forName === resource.name ? fetched : null;
  const loading = resource !== null && kind !== "none" && data === null;

  return (
    <Dialog
      open={resource !== null}
      onOpenChange={(open) => {
        if (!open) {
          // Dropped so reopening the same file never renders a revoked object URL while
          // the fresh fetch is in flight.
          setFetched(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="machine text-sm wrap-break-word">
            {resource?.name}
          </DialogTitle>
          <DialogDescription>
            {resource
              ? `${resourceTypeLabel(resource)}, ${formatSize(resource.size)}. The original file as the researcher reads it.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only" role="status">
              Loading the preview
            </span>
          </div>
        ) : data?.status === "error" && data.error ? (
          <FieldError error={data.error} />
        ) : kind === "pdf" && data?.url ? (
          <iframe
            src={data.url}
            title={resource?.name ?? "PDF preview"}
            className="h-[65vh] w-full rounded-lg border bg-muted/30"
          />
        ) : kind === "image" && data?.url ? (
          // A blob URL, so next/image has nothing to optimise here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.url}
            alt={resource?.name ?? "Image preview"}
            className="max-h-[65vh] w-full rounded-lg border object-contain"
          />
        ) : kind === "text" && data?.text !== null && data?.text !== undefined ? (
          <pre className="machine max-h-[65vh] overflow-auto rounded-lg border bg-muted/50 p-3 text-xs whitespace-pre-wrap">
            {data.text}
          </pre>
        ) : (
          <div className="py-8 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <FileX2 className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <p className="mt-3 text-sm font-medium text-foreground">
              No in-browser preview for this file type
            </p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
              Download it to open the original in the app that owns the format.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (resource) {
                onDownload(resource);
              }
            }}
          >
            <Download data-icon="inline-start" aria-hidden />
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

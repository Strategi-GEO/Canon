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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  previewKind,
  resourceTypeLabel,
  type PreviewKind,
} from "@/components/clients/resource-type";
import { ApiError, api, detailText, putResourceBytes } from "@/portal/api";
import { formatDate } from "@/portal/format";
import type { PortalResource } from "@/portal/types";
import { cn } from "@/lib/utils";

/**
 * The client's own fact base: the documents they hand us, which we read before we write
 * anything for the brand. It is the only surface in the portal where the client is the author
 * and we are the audience, and the whole shape of this view follows from that inversion.
 *
 * ONLY THE CLIENT UPLOADS AND MANAGES THESE. An operator can read them and nothing else, which
 * is why there is no uploader name on a row: with one possible author, a byline would be the
 * same word repeated down the page. Migration 015 enforces the same rule at the database, so
 * this view is not the guarantee; what it buys is that a client is never shown a door the
 * record would slam.
 *
 * NOTHING HERE IS EVER OVERWRITTEN. A filename already in the list is refused, both here
 * before a byte moves and again by the record's own unique constraint, and no branch of this
 * file offers a replace. Replacing a document is delete then upload, two acts the client can
 * see themselves perform, because a silent overwrite of the fact base would change what every
 * future blog is written from with no trace of the change.
 *
 * resourceTypeLabel and previewKind come from the admin surface's resource-type.ts rather than
 * being restated here. They are pure functions over a name and a MIME string whose only import
 * is a type, so nothing admin-only travels with them, and sharing them is what stops the two
 * surfaces labelling one file two ways.
 */

/**
 * The record's own ceiling, from client_resources' size constraint. Checked here so an
 * oversized file is refused in the instant the client picks it, rather than after they have
 * waited for 40 MB to cross the wire to be told no. The record stays the authority.
 */
const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;

/** Bytes, rendered short. The record stores an exact count, so this is rounding for reading. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The object's address, computed in the browser because the browser is the only place the
 * bytes ever are: they go straight to our file store and never pass through a server of ours.
 *
 * crypto.subtle exists only in a secure context, which every deployment of this portal is
 * (https, or localhost in development), so there is no fallback path here. A fallback would be
 * a hand-rolled SHA-256 over 25 MB on the main thread, written to serve a browser this app
 * cannot be reached from.
 */
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * One file's outcome, in the client's words rather than the server's status code. There is no
 * percentage and no progress bar anywhere in this file: fetch reports no upload progress, so a
 * bar would be an animation of a guess, and a guess that stalls at 90% reads as a hang.
 */
type UploadRow = {
  /** Stable across the batch. Two files picked from different folders can share a name. */
  key: string;
  name: string;
  status: "working" | "done" | "failed";
  message: string | null;
};

/**
 * What went wrong, said to the person who chose the file.
 *
 * The 409 arm is the duplicate rule surfacing, and it forwards the record's own sentence
 * because that sentence names the file: the record distinguishes "you already have a file with
 * this name" from "these exact bytes are already here under another name", and only it knows
 * which happened. What this function adds is the reassurance the client actually wants at that
 * moment, which no status code carries.
 *
 * A 403 or a 404 on a WRITE is the role check, not a missing brand. The client reached this
 * page from their own brand list, so the brand exists for them; what they lack is a seat that
 * may change it. Saying "not found" there would send someone hunting for a broken link.
 */
function uploadFailureMessage(error: ApiError, fileName: string): string {
  if (error.isOffline) {
    return `We could not reach the portal, so ${fileName} was not uploaded. Check your connection and try again.`;
  }
  if (error.status === 409) {
    return `${detailText(error)} Nothing was overwritten, and the file you already have is untouched.`;
  }
  if (error.status === 403 || error.status === 404) {
    return "This account can read the files here but cannot add or remove them. Whoever manages your account can change that.";
  }
  if (error.status === 413) {
    return `${fileName} is larger than the 25 MB limit for a single file.`;
  }
  return detailText(error);
}

/** What the list currently holds, stamped with the brand it was loaded for. */
type Loaded = { brand: string; resources: PortalResource[] };

export function ResourcesView({ brand }: { brand: string }) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [failure, setFailure] = React.useState<{ brand: string; error: ApiError } | null>(null);
  const [uploads, setUploads] = React.useState<UploadRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<PortalResource | null>(null);
  const [previewing, setPreviewing] = React.useState<PortalResource | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Both stamps carry the brand they describe, so switching brands shows a loader rather than
  // the previous brand's files: the render derives "still loading" from a stamp that does not
  // match, and no state is written in the effect body to force it.
  const resources = loaded?.brand === brand ? loaded.resources : null;
  const loadError = failure?.brand === brand ? failure.error : null;

  const applyFailed = React.useCallback(
    (forBrand: string, cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }
      setFailure({
        brand: forBrand,
        error: cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
      });
    },
    [],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    api.resources(brand, controller.signal).then(
      (data) => setLoaded({ brand, resources: data.resources }),
      (cause: unknown) => applyFailed(brand, cause),
    );
    return () => controller.abort();
  }, [brand, applyFailed]);

  /**
   * Re-read after an upload or a delete. The list is refetched rather than patched in place so
   * the server stays the one authority on the order: the rows come back sorted by lowercased
   * name, and a local splice would need a second copy of that rule to sit beside a file the
   * first one produced.
   */
  const reload = React.useCallback(async () => {
    try {
      setLoaded({ brand, resources: (await api.resources(brand)).resources });
      setFailure(null);
    } catch (cause) {
      applyFailed(brand, cause);
    }
  }, [brand, applyFailed]);

  /**
   * Files go up ONE AT A TIME and each keeps its own row, because one refusal must never
   * cancel the files behind it: somebody drops six documents and needs to know which of them
   * landed, not that "the upload failed".
   *
   * Each file makes three trips and the order is load-bearing. The bytes reach our file store
   * before the index row is written, so an upload that dies halfway leaves an object nobody
   * can see and costs nothing; retrying the same file computes the same address and simply
   * lands on it again. Writing the index first would leave a file listed but unreadable, and
   * its name would then refuse the very retry that would have fixed it.
   */
  async function upload(files: File[]) {
    if (files.length === 0) {
      return;
    }
    const existing = new Set((resources ?? []).map((resource) => resource.name));
    setUploads(
      files.map((file, index) => ({
        key: `${index}:${file.name}`,
        name: file.name,
        status: "working",
        message: null,
      })),
    );
    setBusy(true);

    const settle = (index: number, status: UploadRow["status"], message: string | null) => {
      setUploads((prev) => prev.map((row, i) => (i === index ? { ...row, status, message } : row)));
    };

    let landed = false;
    for (const [index, file] of files.entries()) {
      if (file.size > MAX_RESOURCE_BYTES) {
        settle(index, "failed", `${file.name} is ${formatSize(file.size)}, over the 25 MB limit for a single file.`);
        continue;
      }
      // The record refuses this too, and refuses it authoritatively. Checking here as well is
      // what turns a 25 MB round trip into an instant answer, and it is the only place a
      // duplicate can be caught before the bytes move at all.
      if (existing.has(file.name)) {
        settle(
          index,
          "failed",
          `${file.name} is already in your files. We never overwrite one, so remove the copy you have if you want to replace it.`,
        );
        continue;
      }
      try {
        const sha256 = await sha256Hex(file);
        const target = await api.resourceUploadTarget(brand, { sha256 });
        await putResourceBytes(target, file);
        await api.indexResource(brand, {
          name: file.name,
          sha256,
          size: file.size,
          // "" where the browser could not tell, which is the same empty string the wire uses
          // for a file whose type was never recorded. The filename decides from there.
          content_type: file.type,
        });
        existing.add(file.name);
        landed = true;
        settle(index, "done", null);
      } catch (cause) {
        const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause));
        settle(index, "failed", uploadFailureMessage(error, file.name));
      }
    }

    setBusy(false);
    if (landed) {
      await reload();
    }
  }

  async function remove(resource: PortalResource) {
    setBusy(true);
    try {
      await api.deleteResource(brand, resource.name);
      setPendingDelete(null);
      await reload();
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause));
      // Reported on the same rail as an upload refusal, so every refusal this page can give
      // appears in one place instead of a toast the client may have looked away from.
      setUploads([
        {
          key: `delete:${resource.name}`,
          name: resource.name,
          status: "failed",
          message: uploadFailureMessage(error, resource.name),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The original file, byte for byte. The ticket is a plain URL carrying an attachment
   * disposition, so the browser saves it straight from our file store and the bytes never
   * touch this tab's memory. A throwaway anchor is what starts that, because assigning
   * location would count as a navigation away from the page.
   */
  async function download(resource: PortalResource) {
    try {
      const link = await api.resourceLink(brand, resource.name, { download: true });
      const anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause));
      setUploads([
        {
          key: `download:${resource.name}`,
          name: resource.name,
          status: "failed",
          message: uploadFailureMessage(error, resource.name),
        },
      ]);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Your files</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Anything you add here is read before we write, so your own brochures, price sheets and
          fact documents shape what goes into a blog. These files are yours: you add and remove
          them, and we only read them.
        </p>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          "rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border bg-muted/30",
        )}
      >
        <Upload className="mx-auto size-4 text-muted-foreground" aria-hidden />
        <p className="mt-2 text-xs text-muted-foreground">
          Drop files here, or pick them yourself. Up to 25 MB each.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
          {busy ? "Uploading" : "Choose files"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Add files"
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            // Cleared so picking the same file again after a refusal still fires a change.
            event.target.value = "";
          }}
        />
      </div>

      {uploads.length > 0 ? (
        <ul className="space-y-1.5" aria-live="polite">
          {uploads.map((row) => (
            <li key={row.key} className="rounded-md border bg-card px-2.5 py-2">
              <div className="flex items-center gap-2">
                {row.status === "working" ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                ) : row.status === "done" ? (
                  <CheckCircle2 className="size-3.5 shrink-0 text-ship" aria-hidden />
                ) : (
                  <TriangleAlert className="size-3.5 shrink-0 text-fail" aria-hidden />
                )}
                <span className="machine min-w-0 flex-1 truncate text-xs text-foreground">
                  {row.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.status === "working" ? "uploading" : row.status === "done" ? "added" : "not added"}
                </span>
              </div>
              {row.message !== null ? (
                <p role="alert" className="mt-1.5 text-xs wrap-anywhere text-fail">
                  {row.message}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {loadError !== null ? (
        <div className="rounded-lg border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">{detailText(loadError)}</p>
          <Button className="mt-2" variant="outline" size="sm" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : resources === null ? (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : resources.length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
          You have not added any files yet. Without them we research your topics from public
          sources alone, so anything only you hold is worth putting here.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {resources.map((resource) => (
            <li
              key={resource.name}
              className="flex items-center gap-2 px-2.5 py-2 transition-colors hover:bg-muted/40"
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button
                type="button"
                onClick={() => setPreviewing(resource)}
                title={`Open ${resource.name}`}
                className="machine min-w-0 flex-1 truncate rounded-sm text-left text-xs text-foreground outline-none transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {resource.name}
              </button>
              <Badge variant="secondary" className="machine shrink-0">
                {resourceTypeLabel(resource)}
              </Badge>
              <span className="machine hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {formatSize(resource.size)}
              </span>
              <span className="machine hidden shrink-0 text-xs text-muted-foreground md:inline">
                {resource.modified === "" ? "" : formatDate(resource.modified)}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Download ${resource.name}`}
                title={`Download ${resource.name}`}
                onClick={() => void download(resource)}
              >
                <Download aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${resource.name}`}
                title={`Remove ${resource.name}`}
                disabled={busy}
                onClick={() => setPendingDelete(resource)}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

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
            <DialogTitle>Remove this file?</DialogTitle>
            <DialogDescription>
              We stop reading it from the next piece we write. Blogs already written from it keep
              whatever they cited, and nothing published changes.
            </DialogDescription>
          </DialogHeader>
          <p className="machine text-xs wrap-break-word text-foreground">{pendingDelete?.name}</p>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (pendingDelete !== null) {
                  void remove(pendingDelete);
                }
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResourcePreviewDialog
        brand={brand}
        resource={previewing}
        onClose={() => setPreviewing(null)}
        onDownload={(resource) => void download(resource)}
      />
    </div>
  );
}

/**
 * What the preview resolved to, stamped with the file it belongs to. State is written only
 * from the settled callbacks and the render reads "still loading" from a stamp that does not
 * match, so an old file's bytes can never appear under a new file's title.
 */
type PreviewData = {
  forName: string;
  status: "ready" | "error";
  /** For pdf and image: handed straight to src=. Null for text, which arrives as `text`. */
  url: string | null;
  text: string | null;
  error: ApiError | null;
};

/**
 * One file, shown where showing it is trivially honest and downloaded where it is not.
 *
 * PDF, image and text preview, and nothing else does. A spreadsheet or a slide deck has no
 * faithful in-browser rendering we could produce, and a half-rendering of a price sheet is
 * worse than a download button: it invites somebody to read a number that may not be the
 * number in the file. So the fourth case says so plainly and offers the original.
 *
 * PDFs and images are pointed AT the file store rather than fetched into this tab, because the
 * ticket is a plain URL an <iframe> or an <img> accepts: the browser streams a 12 MB brochure
 * and renders it with no copy in our hands. Text is fetched, because text has to be read
 * before it can be shown, and text files here are small by nature.
 */
function ResourcePreviewDialog({
  brand,
  resource,
  onClose,
  onDownload,
}: {
  brand: string;
  resource: PortalResource | null;
  onClose: () => void;
  onDownload: (resource: PortalResource) => void;
}) {
  const [fetched, setFetched] = React.useState<PreviewData | null>(null);
  const kind: PreviewKind = resource !== null ? previewKind(resource) : "none";

  React.useEffect(() => {
    if (resource === null || previewKind(resource) === "none") {
      return;
    }
    const wantKind = previewKind(resource);
    const name = resource.name;
    const controller = new AbortController();

    api
      .resourceLink(brand, name, { signal: controller.signal })
      .then(async (link) => {
        if (wantKind !== "text") {
          return { forName: name, status: "ready" as const, url: link.url, text: null, error: null };
        }
        // No Authorization header on this fetch: the ticket carries its own authority, and
        // sending ours to another host is exactly what the ticket exists to avoid.
        const res = await fetch(link.url, { signal: controller.signal });
        if (!res.ok) {
          throw new ApiError(res.status, "This file could not be opened just now");
        }
        return {
          forName: name,
          status: "ready" as const,
          url: null,
          text: await res.text(),
          error: null,
        };
      })
      .then(
        (data) => setFetched(data),
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          setFetched({
            forName: name,
            status: "error",
            url: null,
            text: null,
            error: cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
          });
        },
      );

    return () => controller.abort();
  }, [brand, resource]);

  const data = resource !== null && fetched?.forName === resource.name ? fetched : null;
  const loading = resource !== null && kind !== "none" && data === null;

  return (
    <Dialog
      open={resource !== null}
      onOpenChange={(open) => {
        if (!open) {
          // Dropped so reopening the same file shows a loader rather than a ticket that has
          // since expired: these are short-lived by design.
          setFetched(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="machine text-sm wrap-break-word">{resource?.name}</DialogTitle>
          <DialogDescription>
            {resource !== null
              ? `${resourceTypeLabel(resource)}, ${formatSize(resource.size)}. Your original file, exactly as we read it.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
            <span className="sr-only" role="status">
              Opening this file
            </span>
          </div>
        ) : data?.status === "error" && data.error !== null ? (
          <p role="alert" className="text-xs wrap-anywhere text-fail">
            {detailText(data.error)}
          </p>
        ) : kind === "pdf" && data?.url ? (
          <iframe
            src={data.url}
            title={resource?.name ?? "PDF preview"}
            className="h-[65vh] w-full rounded-lg border bg-muted/30"
          />
        ) : kind === "image" && data?.url ? (
          // A short-lived URL on another host, so next/image has nothing to optimise here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.url}
            alt={resource?.name ?? "Image preview"}
            className="max-h-[65vh] w-full rounded-lg border object-contain"
          />
        ) : kind === "text" && typeof data?.text === "string" ? (
          <pre className="machine max-h-[65vh] overflow-auto rounded-lg border bg-muted/50 p-3 text-xs whitespace-pre-wrap">
            {data.text}
          </pre>
        ) : (
          <div className="py-8 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
              <FileX2 className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <p className="mt-3 text-sm font-medium text-foreground">
              This one opens outside the browser
            </p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
              Download it to read the original in the app that owns the format. We read it either
              way.
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
              if (resource !== null) {
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

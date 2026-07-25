"use client";

import * as React from "react";
import {
  CheckCircle2,
  Download,
  FilePlus2,
  FileX2,
  Loader2,
  Paperclip,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  previewKind,
  resourceTypeLabel,
  type PreviewKind,
} from "@/components/clients/resource-type";

/**
 * The ONE resources surface, shared by the admin console (resources-panel.tsx) and the client
 * portal (portal/resources.tsx), following the roadmap/shared.tsx precedent: the two surfaces
 * used to be parallel lookalikes that drifted (one showed size, one showed date; two date
 * formats for the same field), and the fix is one presentational shell that neither can drift
 * from.
 *
 * TRANSPORT NEVER ENTERS THIS FILE. The admin uploads multipart through the engine and
 * previews authenticated blobs; the portal hashes in the browser, PUTs to Storage on a signed
 * URL, and previews on short-lived signed links. All of that lives behind `ops`: upload one
 * file, remove one resource, download one, resolve one preview to `{url}` or `{text}`. The
 * shell owns everything the eye can compare: the Card, the dropzone, the per-file upload rows,
 * the list rows (type badge, size, date), the delete confirm, and the preview dialog's four
 * cases.
 *
 * The words are per-surface (`copy`), because the admin is told "Resources ... read by the
 * researcher" where the client is told "Your files ... we only read them", and each sentence is
 * right for its reader. The STRUCTURE around the words is what must not fork again.
 */

/** Both wires satisfy this: the engine's Resource and the portal's PortalResource. */
export type ShellResource = {
  name: string;
  size: number;
  /** Optional on the engine wire: rows written before the column existed send nothing. */
  content_type?: string;
  modified?: string;
};

/** What a preview resolves to. `revoke` marks an object URL the shell must release. */
export type ResourcePreviewData = { url: string; revoke?: boolean } | { text: string };

export type ResourceOps<R extends ShellResource> = {
  /** Send one file. Throw to refuse it; the shell renders the refusal on the file's own row. */
  upload: (file: File) => Promise<void>;
  /** Remove one resource. Success is silent here; the wrapper may toast. */
  remove: (resource: R) => Promise<void>;
  /** Save the original file. Owns its own anchor mechanics. */
  download: (resource: R) => Promise<void> | void;
  /** Resolve one previewable resource to something src= or <pre> can take. */
  preview: (
    resource: R,
    kind: Exclude<PreviewKind, "none">,
    signal: AbortSignal,
  ) => Promise<ResourcePreviewData>;
};

export type ResourcesCopy = {
  title: string;
  blurb: string;
  dropHint: string;
  empty: string;
  /** The status word on a finished upload row, e.g. "uploaded" / "added". */
  statusDone: string;
  /** The status word on a refused upload row, e.g. "refused" / "not added". */
  statusFailed: string;
  deleteTitle: string;
  deleteBody: string;
  deleteAction: string;
  /** The sentence after "type, size." in the preview description. */
  previewTagline: string;
  previewNoneTitle: string;
  previewNoneBody: string;
};

/** The admin console's words, the defaults the portal overrides. */
const ADMIN_COPY: ResourcesCopy = {
  title: "Resources",
  blurb:
    "Files uploaded here are read by the researcher before any external search, so this is " +
    "how a client's own documents reach the blog.",
  dropHint: "Drop files here, or pick them yourself. 25 MB per file.",
  empty: "No resources yet. The researcher will go straight to external sources.",
  statusDone: "uploaded",
  statusFailed: "refused",
  deleteTitle: "Delete this resource?",
  deleteBody:
    "The researcher stops reading it on the next run. Blogs already written from it keep " +
    "whatever they cited.",
  deleteAction: "Delete",
  previewTagline: "The original file as the researcher reads it.",
  previewNoneTitle: "No in-browser preview for this file type",
  previewNoneBody: "Download it to open the original in the app that owns the format.",
};

/** The record's ceiling, checked before a byte moves so a 40 MB pick refuses instantly. */
const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;

/** A composed note needs an extension so it previews as text and lands with a sane type; default .txt. */
function withTextExtension(name: string): string {
  const trimmed = name.trim();
  return /\.[^./\\]+$/.test(trimmed) ? trimmed : `${trimmed}.txt`;
}

/** Bytes, rendered short. Both records store an exact count, so this is rounding for reading. */
export function formatSize(bytes: number): string {
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

/** An ISO timestamp shown as a plain date. Invalid input falls back to the raw string. */
export function formatDate(iso: string): string {
  if (!iso) {
    return "";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toISOString().slice(0, 10);
}

/** The upload timestamp, from whichever key this wire sends (engine: uploaded; portal: modified). */
function uploadedAt(resource: ShellResource): string {
  const wire = resource as ShellResource & { uploaded?: string };
  return wire.uploaded ?? resource.modified ?? "";
}

/** One file's outcome. No percentage: fetch reports no upload progress, so a bar would animate a guess. */
type UploadRow = {
  /** Stable across the batch. Two files picked from different folders can share a name. */
  key: string;
  name: string;
  status: "uploading" | "done" | "error";
  error: React.ReactNode | null;
};

export function ResourcesShell<R extends ShellResource>({
  resources,
  loadErrorView,
  ops,
  onChanged,
  renderError,
  readOnly = false,
  copy: copyOverrides,
}: {
  /** Null while loading; the skeleton renders from it. */
  resources: R[] | null;
  /** The list-load failure, already rendered in the surface's own error vocabulary. */
  loadErrorView: React.ReactNode | null;
  ops: ResourceOps<R>;
  /** Called after an upload lands or a delete succeeds, so the owner re-reads its list. */
  onChanged: () => Promise<void> | void;
  /** A refusal, said to this surface's reader: FieldError for the admin, a sentence for the client. */
  renderError: (cause: unknown, fileName: string) => React.ReactNode;
  /** True on the hosted admin build: list and preview stay, every write disappears. */
  readOnly?: boolean;
  copy?: Partial<ResourcesCopy>;
}) {
  const copy: ResourcesCopy = { ...ADMIN_COPY, ...copyOverrides };
  const [uploads, setUploads] = React.useState<UploadRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<R | null>(null);
  const [previewing, setPreviewing] = React.useState<R | null>(null);
  const [composerOpen, setComposerOpen] = React.useState(false);
  const [composerName, setComposerName] = React.useState("");
  const [composerText, setComposerText] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  /**
   * Files go up ONE AT A TIME and each keeps its own row, because one refusal must never
   * cancel the files behind it: somebody drops six documents and needs to know which of them
   * landed, not that "the upload failed". Indexed, not keyed by name: two files dropped from
   * different folders can share a name, and matching on the name would report one file's
   * refusal against the other.
   */
  async function upload(files: File[]) {
    if (files.length === 0) {
      return;
    }
    setUploads(
      files.map((file, index) => ({
        key: `${index}:${file.name}`,
        name: file.name,
        status: "uploading",
        error: null,
      })),
    );
    setBusy(true);

    const settle = (index: number, status: UploadRow["status"], error: React.ReactNode | null) => {
      setUploads((prev) => prev.map((row, i) => (i === index ? { ...row, status, error } : row)));
    };

    let landed = false;
    for (const [index, file] of files.entries()) {
      // Checked here as well as by the record, because this is the only place an oversized
      // file can be refused before its bytes make the trip.
      if (file.size > MAX_RESOURCE_BYTES) {
        settle(
          index,
          "error",
          `${file.name} is ${formatSize(file.size)}, over the 25 MB limit for a single file.`,
        );
        continue;
      }
      try {
        await ops.upload(file);
        landed = true;
        settle(index, "done", null);
      } catch (cause) {
        settle(index, "error", renderError(cause, file.name));
      }
    }

    setBusy(false);
    if (landed) {
      await onChanged();
    }
  }

  async function remove(resource: R) {
    setBusy(true);
    try {
      await ops.remove(resource);
      setPendingDelete(null);
      await onChanged();
    } catch (cause) {
      // Reported on the same rail as an upload refusal, so every refusal this surface can
      // give appears in one place instead of a toast the reader may have looked away from.
      setUploads([
        {
          key: `delete:${resource.name}`,
          name: resource.name,
          status: "error",
          error: renderError(cause, resource.name),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  // A typed note is just a File built in the browser, so it rides the same upload() path as a
  // picked file: same row, same size check, same refusal rendering, same reload.
  function saveComposed() {
    const file = new File([composerText], withTextExtension(composerName), { type: "text/plain" });
    setComposerOpen(false);
    setComposerName("");
    setComposerText("");
    void upload([file]);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-foreground">{copy.title}</CardTitle>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.blurb}</p>
      </CardHeader>
      <CardContent>
        {readOnly ? null : (
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
            <p className="mt-2 text-xs text-muted-foreground">{copy.dropHint}</p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
              >
                {busy ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
                {busy ? "Uploading" : "Choose files"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setComposerOpen(true)}
              >
                <FilePlus2 data-icon="inline-start" aria-hidden />
                New text file
              </Button>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="sr-only"
              aria-label="Upload resources"
              onChange={(event) => {
                void upload(Array.from(event.target.files ?? []));
                // Cleared so re-picking the same file after a refusal still fires a change.
                event.target.value = "";
              }}
            />
          </div>
        )}

        {uploads.length > 0 ? (
          <ul className="mt-3 space-y-1.5" aria-live="polite">
            {uploads.map((row) => (
              <li key={row.key} className="rounded-md border px-2.5 py-2">
                <div className="flex items-center gap-2">
                  {row.status === "uploading" ? (
                    <Loader2
                      className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                      aria-hidden
                    />
                  ) : row.status === "done" ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-ship" aria-hidden />
                  ) : (
                    // The refusal icon the rest of the app uses, never a tinted file icon:
                    // a red paperclip reads as a broken file, not a refused upload.
                    <TriangleAlert className="size-3.5 shrink-0 text-fail" aria-hidden />
                  )}
                  <span className="machine min-w-0 flex-1 truncate text-xs text-foreground">
                    {row.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.status === "uploading"
                      ? "uploading"
                      : row.status === "done"
                        ? copy.statusDone
                        : copy.statusFailed}
                  </span>
                </div>
                {row.error !== null ? <div className="mt-1.5">{row.error}</div> : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-4">
          {loadErrorView}

          {resources === null ? (
            <div className="space-y-2">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : resources.length === 0 && loadErrorView === null ? (
            <p className="text-xs text-muted-foreground">{copy.empty}</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {resources.map((resource) => (
                <li
                  key={resource.name}
                  className="flex items-center gap-2 px-2.5 py-2 transition-colors hover:bg-muted/40"
                >
                  <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {/* The hosted admin build cannot stream bytes, so it shows a plain name
                      where every other build shows a preview trigger. */}
                  {readOnly ? (
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
                    {formatSize(resource.size)}
                  </span>
                  <span className="machine hidden shrink-0 text-xs text-muted-foreground md:inline">
                    {formatDate(uploadedAt(resource))}
                  </span>
                  {readOnly ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Download ${resource.name}`}
                      title={`Download ${resource.name}`}
                      onClick={() => void ops.download(resource)}
                    >
                      <Download aria-hidden />
                    </Button>
                  )}
                  {readOnly ? null : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`${copy.deleteAction} ${resource.name}`}
                      disabled={busy}
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
        open={composerOpen}
        onOpenChange={(open) => {
          if (!open) {
            setComposerOpen(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New text file</DialogTitle>
            <DialogDescription>Type your text and save it as a resource.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="resource-file-name">File name</Label>
              <Input
                id="resource-file-name"
                value={composerName}
                onChange={(event) => setComposerName(event.target.value)}
                placeholder="notes.txt"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resource-file-text">Content</Label>
              <Textarea
                id="resource-file-text"
                value={composerText}
                onChange={(event) => setComposerText(event.target.value)}
                placeholder="Write your text here."
                rows={10}
                className="machine text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setComposerOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || composerName.trim() === "" || composerText === ""}
              onClick={saveComposed}
            >
              Save as resource
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <DialogTitle>{copy.deleteTitle}</DialogTitle>
            <DialogDescription>{copy.deleteBody}</DialogDescription>
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
              {copy.deleteAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResourcePreviewDialog
        resource={previewing}
        ops={ops}
        copy={copy}
        renderError={renderError}
        onClose={() => setPreviewing(null)}
      />
    </Card>
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
  url: string | null;
  revoke: boolean;
  text: string | null;
  error: React.ReactNode | null;
};

/**
 * One file, shown where showing it is trivially honest and downloaded where it is not: PDF,
 * image and text preview, and nothing else does. A spreadsheet has no faithful in-browser
 * rendering, and a half-rendering of a price sheet invites somebody to read a number that may
 * not be the number in the file, so the fourth case says so plainly and offers the original.
 */
function ResourcePreviewDialog<R extends ShellResource>({
  resource,
  ops,
  copy,
  renderError,
  onClose,
}: {
  resource: R | null;
  ops: ResourceOps<R>;
  copy: ResourcesCopy;
  renderError: (cause: unknown, fileName: string) => React.ReactNode;
  onClose: () => void;
}) {
  const [fetched, setFetched] = React.useState<PreviewData | null>(null);
  const kind: PreviewKind = resource !== null ? previewKind(resource) : "none";

  // The fetch lives and dies with the dialog: closing aborts an in-flight request, and the
  // cleanup revokes any object URL so a session of previews never leaks blob memory. The
  // "none" kind fetches nothing, because there is nothing this dialog could do with it.
  React.useEffect(() => {
    if (resource === null || previewKind(resource) === "none") {
      return;
    }
    const wantKind = previewKind(resource) as Exclude<PreviewKind, "none">;
    const name = resource.name;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    ops.preview(resource, wantKind, controller.signal).then(
      (data) => {
        if ("text" in data) {
          setFetched({ forName: name, status: "ready", url: null, revoke: false, text: data.text, error: null });
        } else {
          objectUrl = data.revoke === true ? data.url : null;
          setFetched({
            forName: name,
            status: "ready",
            url: data.url,
            revoke: data.revoke === true,
            text: null,
            error: null,
          });
        }
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setFetched({
          forName: name,
          status: "error",
          url: null,
          revoke: false,
          text: null,
          error: renderError(cause, name),
        });
      },
    );

    return () => {
      controller.abort();
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    // renderError is a render-time closure; re-running the fetch when it changes would
    // re-download the file on every parent render for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, ops]);

  // Data for THIS file only. A stamp from an earlier preview means the fetch is still in
  // flight, which the render below reads as loading rather than showing stale bytes.
  const data = resource !== null && fetched?.forName === resource.name ? fetched : null;
  const loading = resource !== null && kind !== "none" && data === null;

  return (
    <Dialog
      open={resource !== null}
      onOpenChange={(open) => {
        if (!open) {
          // Dropped so reopening the same file never renders a revoked or expired URL while
          // the fresh fetch is in flight.
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
              ? `${resourceTypeLabel(resource)}, ${formatSize(resource.size)}. ${copy.previewTagline}`
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
        ) : data?.status === "error" && data.error !== null ? (
          data.error
        ) : kind === "pdf" && data?.url ? (
          <iframe
            src={data.url}
            title={resource?.name ?? "PDF preview"}
            className="h-[65vh] w-full rounded-lg border bg-muted/30"
          />
        ) : kind === "image" && data?.url ? (
          // A blob or short-lived URL, so next/image has nothing to optimise here.
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
            <p className="mt-3 text-sm font-medium text-foreground">{copy.previewNoneTitle}</p>
            <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
              {copy.previewNoneBody}
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
                void ops.download(resource);
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

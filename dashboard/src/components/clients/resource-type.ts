/**
 * One reading of "what kind of file is this", shared by the Resources panel and the brand
 * overview's summary card so the two can never label one file two ways.
 *
 * The engine's `content_type` wins when present, because it was recorded at upload from the
 * file itself. The filename extension is the fallback for engine builds that predate the
 * field and for files dropped into Resources/ by hand.
 */

import type { Resource } from "@/types";

/** How the preview dialog should render the bytes. "none" offers download only. */
export type PreviewKind = "pdf" | "image" | "text" | "none";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);

const TEXT_EXTENSIONS = new Set(["txt", "csv", "tsv", "md", "markdown", "json", "log", "yaml", "yml"]);

/** MIME to badge label, checked before the extension. Longest prefixes first. */
const MIME_LABELS: [string, string][] = [
  ["application/pdf", "PDF"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml", "DOCX"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml", "XLSX"],
  ["application/vnd.openxmlformats-officedocument.presentationml", "PPTX"],
  ["application/msword", "DOC"],
  ["application/vnd.ms-excel", "XLS"],
  ["application/vnd.ms-powerpoint", "PPT"],
  ["application/json", "JSON"],
  ["application/zip", "ZIP"],
  ["text/csv", "CSV"],
  ["text/markdown", "MD"],
  ["text/html", "HTML"],
  ["text/plain", "TXT"],
];

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The short label the type badge shows. Uppercase, five characters at most, "FILE" when
 * nothing is known: a badge that sometimes ran to a whole MIME string would break the row.
 */
export function resourceTypeLabel(resource: Pick<Resource, "name" | "content_type">): string {
  const mime = resource.content_type?.toLowerCase() ?? "";
  if (mime !== "") {
    for (const [prefix, label] of MIME_LABELS) {
      if (mime.startsWith(prefix)) {
        return label;
      }
    }
    if (mime.startsWith("image/")) {
      return "IMG";
    }
  }

  const ext = extensionOf(resource.name);
  if (ext === "") {
    return "FILE";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "IMG";
  }
  return ext.slice(0, 5).toUpperCase();
}

/** Which preview the dialog can honestly offer. Anything unknown is "none", never a guess. */
export function previewKind(resource: Pick<Resource, "name" | "content_type">): PreviewKind {
  const mime = resource.content_type?.toLowerCase() ?? "";
  const ext = extensionOf(resource.name);

  if (mime.startsWith("application/pdf") || ext === "pdf") {
    return "pdf";
  }
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (
    mime.startsWith("text/") ||
    mime.startsWith("application/json") ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    return "text";
  }
  return "none";
}

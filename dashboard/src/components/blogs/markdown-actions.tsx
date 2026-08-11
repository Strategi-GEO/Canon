"use client";

import * as React from "react";
import { Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Copy and download one piece of raw markdown. The operator's next move is pasting it into a CMS
 * or a composer, so both are one click and both say so afterwards.
 *
 * SHARED BY THE BLOG STAGE AND THE CHANNEL REVIEW, which is the whole reason it is a file. It
 * began inside blog-stage as `Artifacts`, and the channel page grew its own thinner Copy button
 * with different words, no download at all and a silent failure arm. Two surfaces reviewing two
 * artifacts of the same brand should not offer two different toolbars for the identical act, so
 * the control moved out rather than being copied a third time when Medium arrives.
 *
 * `raw === null` means the text has not loaded, and both buttons disable rather than hide: this
 * sits in a row of controls whose widths would otherwise shuffle as an artifact lands.
 */
export function MarkdownActions({
  raw,
  filename,
  what,
}: {
  /** The markdown itself, or null while it loads. */
  raw: string | null;
  /** What the download lands as, extension included. */
  filename: string;
  /** The noun for the toasts and the labels: "blog.md", "LinkedIn post". */
  what: string;
}) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (raw === null) {
      return;
    }
    try {
      // The raw markdown, never the rendered HTML: the operator is pasting into a CMS.
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      toast.success(`Copied ${what}`, { description: "Raw markdown is on the clipboard." });
    } catch (cause) {
      toast.error("Could not copy", { description: String(cause) });
    }
  }

  function download() {
    if (raw === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([raw], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    toast.success("Downloaded", { description: filename });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="outline" onClick={() => void copy()} disabled={raw === null}>
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied ? "Copied" : "Copy markdown"}
      </Button>
      <Button
        size="icon-sm"
        variant="outline"
        onClick={download}
        disabled={raw === null}
        aria-label={`Download ${what}`}
      >
        <Download aria-hidden />
      </Button>
    </div>
  );
}

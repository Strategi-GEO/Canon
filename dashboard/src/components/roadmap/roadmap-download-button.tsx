"use client";

import * as React from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError, api } from "@/lib/api";
import { sheetToCsv } from "@/lib/roadmap-csv";

/**
 * Downloads one month's roadmap as a CSV the operator can open in Excel or Sheets.
 *
 * It fetches the month's sheet fresh on click and serialises it in the browser, so the file is
 * the sheet on disk right now and no server round trip builds it. `month` names which month;
 * when it is undefined the latest is resolved from the month list, which is the toolbar's
 * "download the current roadmap" case where the tab does not track a month number.
 *
 * `compact` is the icon-only form for the preview sidebar, sitting beside each month's delete;
 * the labelled form sits on the tab toolbar beside Preview.
 */
export function RoadmapDownloadButton({
  brandSlug,
  month,
  label,
  compact = false,
}: {
  brandSlug: string;
  /** A specific month, or undefined to download the latest. */
  month?: number;
  /** Names the target for the sr-only text and the button title, e.g. "Month 3 Roadmap". */
  label: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);

  async function download() {
    setBusy(true);
    try {
      // Resolve the latest month when none was passed, so the filename can name it.
      let target = month;
      if (target === undefined) {
        const { months } = await api.roadmapMonths(brandSlug);
        target = months.at(-1)?.month;
        if (target === undefined) {
          toast.error("Nothing to download", { description: "This brand has no roadmap yet." });
          return;
        }
      }

      const sheet = await api.roadmapSheet(brandSlug, undefined, target);
      const filename = `${brandSlug}-month-${target}-roadmap.csv`;
      const url = URL.createObjectURL(
        new Blob([sheetToCsv(sheet.columns, sheet.rows)], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success("Downloaded", { description: filename });
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : String(cause);
      toast.error("Could not download the roadmap", { description: message });
    } finally {
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={busy}
        onClick={() => void download()}
        title={`Download ${label}`}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
        <span className="sr-only">Download {label}</span>
      </Button>
    );
  }

  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => void download()}>
      {busy ? (
        <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
      ) : (
        <Download data-icon="inline-start" aria-hidden />
      )}
      Download
    </Button>
  );
}

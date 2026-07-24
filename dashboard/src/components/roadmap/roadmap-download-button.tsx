"use client";

import * as React from "react";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ApiError, api } from "@/lib/api";
import { sheetToCsv } from "@/lib/roadmap-csv";
import { roadmapXlsxBlob } from "@/lib/roadmap-xlsx";

type Format = "xlsx" | "csv";

/**
 * Downloads one month's roadmap, in either of two formats, because the two are for two different
 * people:
 *
 * - **Excel (.xlsx)** is the one to SHOW A CLIENT: a styled table with a title, a header, wrapped
 *   cells and column widths. CSV cannot carry any of that.
 * - **CSV** is the one to EDIT and re-upload: the uploader accepts .csv only, so this stays the
 *   round-trippable copy.
 *
 * Both fetch the month's sheet fresh on click and serialise it in the browser, so the file is the
 * sheet on disk right now and no server round trip builds it. `month` names which month; when it
 * is undefined the latest is resolved from the month list.
 *
 * `compact` is the icon-only form for the preview sidebar; the labelled form sits on the tab
 * toolbar. Both are a dropdown, so the format is one deliberate choice rather than a guess baked
 * into the button.
 */
export function RoadmapDownloadButton({
  brandSlug,
  brandName,
  month,
  label,
  compact = false,
}: {
  brandSlug: string;
  /** Names the brand on the Excel title row, so a client sees whose roadmap it is. */
  brandName: string;
  /** A specific month, or undefined to download the latest. */
  month?: number;
  /** Names the target for the sr-only text and the button title, e.g. "Month 3 Roadmap". */
  label: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = React.useState(false);

  async function download(format: Format) {
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
      const base = `${brandSlug}-month-${target}-roadmap`;

      let blob: Blob;
      let filename: string;
      if (format === "csv") {
        blob = new Blob([sheetToCsv(sheet.columns, sheet.rows)], {
          type: "text/csv;charset=utf-8",
        });
        filename = `${base}.csv`;
      } else {
        // Colon, never a dash: the dashboard bans em and en dashes everywhere.
        const title = `${brandName} Content Roadmap: Month ${target}`;
        blob = await roadmapXlsxBlob(sheet.columns, sheet.rows, title);
        filename = `${base}.xlsx`;
      }

      const url = URL.createObjectURL(blob);
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

  const trigger = compact ? (
    <Button size="icon-sm" variant="ghost" disabled={busy} title={`Download ${label}`}>
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
      <span className="sr-only">Download {label}</span>
    </Button>
  ) : (
    <Button size="sm" variant="outline" disabled={busy}>
      {busy ? (
        <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
      ) : (
        <Download data-icon="inline-start" aria-hidden />
      )}
      Download
      <ChevronDown data-icon="inline-end" aria-hidden />
    </Button>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem onSelect={() => void download("xlsx")}>
          <Download aria-hidden />
          <span className="flex flex-col">
            <span>Excel (.xlsx)</span>
            <span className="text-xs text-muted-foreground">Formatted, to show a client</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void download("csv")}>
          <Download aria-hidden />
          <span className="flex flex-col">
            <span>CSV</span>
            <span className="text-xs text-muted-foreground">Plain, to edit and re-upload</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

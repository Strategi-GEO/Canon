/**
 * The roadmap month as a PRESENTABLE .xlsx a client can be shown: a styled table with a title
 * row, a dark header, wrapped cells, striped rows, thin borders, a frozen header, and column
 * widths sized to what each column holds.
 *
 * This is the client-facing sibling of sheetToCsv. The CSV stays, because it is the editable,
 * re-uploadable copy (the uploader accepts .csv only); this is the read-only, hand-to-the-client
 * copy that CSV cannot be, because CSV carries no formatting and no wrapping at all.
 *
 * `write-excel-file` is dynamic-imported inside the blob builder, so the library only loads when
 * an export is actually run, and never sits in the initial bundle. The cell-building
 * (buildRoadmapSheet) is pure and library-free, so it is unit-testable without a browser.
 */
import type { CellObject, SheetData } from "write-excel-file/browser";

const HEADER_BG = "#1F2937"; // slate-800
const HEADER_TEXT = "#FFFFFF";
const TITLE_TEXT = "#111827";
const BORDER = "#D9DDE3";
const STRIPE = "#F6F7F9";

/** Header text drives the column width, because the header is the only stable name a column has:
 *  a generated sheet writes the ten house headers and an operator renames them, but a prompts
 *  cell is always prose and a difficulty is always a two-digit number. Unknown columns get a
 *  sensible middle width.
 *
 *  The checks are substrings and the FIRST HIT WINS, so no rule keys on a word two headers share:
 *  "content" would catch Content Topic and Content Type both, and "query" would catch Query
 *  Volume and Query Intent both. Each rule matches the word that is unique to its column. The
 *  three volume columns (Keyword Volume, AI Search Volume, Query Volume) deliberately share the
 *  last rule, because each holds a bare number and a rule per column would be three ways to
 *  spell 14. */
function columnWidth(header: string): number {
  const h = header.toLowerCase();
  if (h.includes("prompt")) return 52;
  if (h.includes("cover")) return 44;
  if (h.includes("topic")) return 34;
  if (h.includes("type")) return 18;
  if (h.includes("intent")) return 18;
  if (h.includes("difficulty")) return 14;
  if (h.includes("cost")) return 12;
  if (h.includes("volume")) return 14;
  return 26;
}

/** The engine joins several target prompts into one cell with " | " (generated sheets) or
 *  newlines (operator sheets). For a readable cell, put each prompt on its own line so wrap
 *  renders them as a list rather than one run-on line. */
function tidyCell(text: string): string {
  if (!text.includes(" | ")) {
    return text;
  }
  return text
    .split(" | ")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n");
}

function headerCell(text: string): CellObject {
  return {
    value: text,
    fontWeight: "bold",
    textColor: HEADER_TEXT,
    backgroundColor: HEADER_BG,
    align: "left",
    alignVertical: "center",
    wrap: true,
    borderColor: BORDER,
    borderStyle: "thin",
    height: 24,
  };
}

function dataCell(text: string, striped: boolean): CellObject {
  const value = tidyCell(text);
  return {
    // An empty cell keeps its border and stripe but carries no value, so the grid stays a
    // rectangle without writing a stray empty string.
    value: value === "" ? undefined : value,
    wrap: true,
    alignVertical: "top",
    fontSize: 11,
    borderColor: BORDER,
    borderStyle: "thin",
    ...(striped ? { backgroundColor: STRIPE } : {}),
  };
}

/**
 * Build the styled sheet data plus its column widths and frozen-row count. Pure: no library, so
 * it runs and asserts in node.
 */
export function buildRoadmapSheet(
  columns: string[],
  rows: string[][],
  title?: string,
): { data: SheetData; columns: { width: number }[]; stickyRowsCount: number } {
  const ncols = Math.max(columns.length, 1);
  const data: SheetData = [];

  if (title && title.trim() !== "") {
    // A merged title cell across the whole width. columnSpan combines the next N-1 cells, which
    // must still be present as null (write-excel-file ignores them).
    const titleRow: (CellObject | null)[] = [
      {
        value: title,
        columnSpan: ncols,
        fontWeight: "bold",
        fontSize: 15,
        textColor: TITLE_TEXT,
        alignVertical: "center",
        height: 30,
      },
      ...Array<null>(ncols - 1).fill(null),
    ];
    data.push(titleRow);
  }

  data.push(columns.map(headerCell));
  rows.forEach((row, i) => {
    data.push(columns.map((_, c) => dataCell(row[c] ?? "", i % 2 === 1)));
  });

  return {
    data,
    columns: columns.map((col) => ({ width: columnWidth(col) })),
    // Freeze the header (and the title above it when present), so it stays put as the client
    // scrolls a long roadmap.
    stickyRowsCount: title && title.trim() !== "" ? 2 : 1,
  };
}

/** The styled roadmap as an .xlsx Blob, ready to download. */
export async function roadmapXlsxBlob(
  columns: string[],
  rows: string[][],
  title?: string,
): Promise<Blob> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const { data, columns: columnWidths, stickyRowsCount } = buildRoadmapSheet(columns, rows, title);
  return writeXlsxFile(data, {
    columns: columnWidths,
    stickyRowsCount,
    sheet: "Content Roadmap",
  }).toBlob();
}

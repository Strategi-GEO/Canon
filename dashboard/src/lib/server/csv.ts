/**
 * A minimal RFC 4180 CSV reader for the roadmap sheet preview, matching what Python's
 * csv.reader does with the sheets this app stores: quoted cells may contain commas, doubled
 * quotes, and NEWLINES (the target-prompts cells rely on that), and rows may be ragged.
 *
 * Read-only and preview-only: parsing for the ENGINE stays in server/roadmap.py, and the
 * hosted roadmap endpoint reads the already-parsed roadmap_rows table rather than this. This
 * exists solely because /roadmap/sheet renders the raw file as a rectangle.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let started = false;

  const push = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ",") {
      push();
      started = true;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") {
        i += 1;
      }
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      cell += ch;
      started = true;
    }
  }
  // A trailing line without a newline still counts; a file ending in a newline does not gain
  // a phantom empty row.
  if (started || cell !== "" || row.length > 0) {
    endRow();
  }
  return rows;
}

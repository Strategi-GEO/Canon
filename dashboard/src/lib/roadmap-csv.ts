/**
 * The roadmap sheet as an RFC-4180 CSV string, built in the browser from the sheet the preview
 * already fetched.
 *
 * No dependency. The rules are small enough to hand-roll, and pulling in an xlsx library to emit
 * a file every spreadsheet opens natively would be weight for nothing: Excel and Sheets both read
 * CSV directly.
 *
 * Trailing empty cells are dropped per row before serialising. The engine pads every row to a
 * common width so the preview can render a rectangle, and emitting that padding would write rows
 * ending in bare commas the operator never typed. A field is quoted ONLY when it must be, meaning
 * it contains a comma, a double quote, CR or LF, and an inner quote is escaped by doubling it.
 * Lines are joined with CRLF, which is what RFC 4180 specifies.
 */
export function sheetToCsv(columns: string[], rows: string[][]): string {
  return [columns, ...rows].map(toLine).join("\r\n");
}

function toLine(row: string[]): string {
  return trimTrailingEmpty(row).map(escapeField).join(",");
}

function trimTrailingEmpty(row: string[]): string[] {
  let end = row.length;
  while (end > 0 && row[end - 1] === "") {
    end -= 1;
  }
  return row.slice(0, end);
}

function escapeField(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

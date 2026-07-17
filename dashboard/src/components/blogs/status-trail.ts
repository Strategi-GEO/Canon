/**
 * Reads status.jsonl, the run feed the engine appends one JSON line to per stage boundary.
 *
 * Two things in that file are worth an operator's attention and exist nowhere else in the
 * API: the score at each iteration, and the note on the terminal line. GET /blogs reports
 * only the FINAL score, so "96" alone hides whether the piece landed there or clawed its way
 * up from 88. And needs_review without its reason is a status that tells a human to act
 * while withholding what to act on, which is the one thing they need.
 *
 * Every value here is lifted from the engine's own line. Nothing is derived, inferred or
 * defaulted: a file that does not say something means this module returns null for it.
 */

/** One appended line. Every field is optional because a half-written line must not throw. */
type StatusLine = {
  stage?: string;
  event?: string;
  iter?: number;
  score?: number | null;
  status?: string;
  note?: string;
  ts?: string;
};

export type RunTrail = {
  /** The eval score at each iteration, oldest first. Empty when no eval ever ended. */
  scores: number[];
  /** The terminal line's note: the engine's own words for why the run ended as it did. */
  terminalNote: string | null;
  terminalStatus: string | null;
};

const EMPTY: RunTrail = { scores: [], terminalNote: null, terminalStatus: null };

function parseLines(jsonl: string): StatusLine[] {
  const lines: StatusLine[] = [];
  for (const raw of jsonl.split("\n")) {
    const text = raw.trim();
    if (text === "") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      // A run that crashed mid-write can leave a truncated last line. One bad line is not a
      // reason to drop the ninety good ones above it.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        lines.push(parsed as StatusLine);
      }
    } catch {
      continue;
    }
  }
  return lines;
}

export function readTrail(jsonl: string): RunTrail {
  const lines = parseLines(jsonl);
  if (lines.length === 0) {
    return EMPTY;
  }

  // Keyed by iteration, last write wins: the engine can end the same eval twice, once as
  // "running" and again carrying the terminal status. Both report the same score, and taking
  // the last keeps one number per iteration rather than 96 twice in the trail.
  const byIter = new Map<number, number>();
  for (const line of lines) {
    if (
      line.stage === "eval" &&
      line.event === "end" &&
      typeof line.score === "number" &&
      typeof line.iter === "number"
    ) {
      byIter.set(line.iter, line.score);
    }
  }
  const scores = [...byIter.entries()].sort((a, b) => a[0] - b[0]).map(([, score]) => score);

  // The terminal line is the last one that stopped saying "running". Scanning from the end
  // matters: earlier lines carry a running status even on a run that has long since ended.
  let terminal: StatusLine | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const status = lines[i].status;
    if (typeof status === "string" && status !== "running") {
      terminal = lines[i];
      break;
    }
  }

  return {
    scores,
    terminalNote:
      typeof terminal?.note === "string" && terminal.note.trim() !== ""
        ? terminal.note.trim()
        : null,
    terminalStatus: typeof terminal?.status === "string" ? terminal.status : null,
  };
}

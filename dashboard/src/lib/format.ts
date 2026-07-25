/**
 * Display formatting for machine values.
 *
 * Every timestamp the engine writes is UTC ISO 8601. An operator thinks in "did that finish
 * before lunch", not in UTC, so a bare ISO string is the wrong thing to show. Relative time
 * answers the question they actually have; the absolute form goes in a tooltip so the exact
 * value is one hover away rather than gone.
 */

const ABSOLUTE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Thousands separators, so 1847 reads as a word count and not as a run id. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

/**
 * "just now", "4 min ago", "3 hr ago", "yesterday", then a date once relative stops helping.
 * Past tense only: the engine never timestamps the future, and a clock skew that produced
 * "in 2 min" would read as a bug rather than as information.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "unknown";
  }

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 45) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  return ABSOLUTE.format(then);
}

/** "16 Jul 2026, 14:32". The exact value, for tooltips and for anywhere relative time lies. */
export function formatAbsolute(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "unknown";
  }
  return ABSOLUTE.format(then);
}

/**
 * Elapsed time for a run in flight. Shows seconds under a minute because the first 60 seconds
 * of a blog are when an operator is most likely to think nothing is happening.
 */
export function formatElapsed(startedIso: string, now: Date = new Date()): string {
  const started = new Date(startedIso);
  if (Number.isNaN(started.getTime())) {
    return "";
  }
  const seconds = Math.max(0, Math.round((now.getTime() - started.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

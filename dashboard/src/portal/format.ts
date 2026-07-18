/**
 * Display formatting for machine values. Every timestamp on the portal wire is UTC ISO
 * 8601; a client thinks in "last week", not in UTC, so relative time answers the question
 * they actually have and the absolute form sits in a tooltip.
 */

const ABSOLUTE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

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

/** "16 Jul 2026". Client-facing dates carry no clock time; the day is the story. */
export function formatDate(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "unknown";
  }
  return ABSOLUTE.format(then);
}

/** Reading time at a deliberately unhurried 200 wpm, floored at one minute. */
export function readingTime(wordCount: number): string {
  const minutes = Math.max(1, Math.round(wordCount / 200));
  return `${minutes} min read`;
}

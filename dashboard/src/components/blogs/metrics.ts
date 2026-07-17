/**
 * Measurements taken from a draft's own text.
 *
 * Word count is NOT on the wire, and the obvious `text.split(/\s+/)` would put a different
 * number on screen than the one the engine's word-count gate enforced against the 1200-2000
 * band. Two numbers for one draft is worse than no number, so this mirrors gates.py exactly:
 * strip link syntax, blank the markdown table and heading punctuation, then count tokens on
 * the same character class the gate uses.
 */

/** gates.py strip_links: [anchor](url) keeps the anchor, images and bare URLs go entirely. */
function stripLinks(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "");
}

/**
 * The engine's count, to the token. The one deliberate divergence: Python's \w is unicode
 * aware and JavaScript's is ASCII, so a draft leaning on non-ASCII letters could read a word
 * or two below the gate's number. English drafts with rupee and percent signs, which the
 * character class already covers, agree exactly.
 */
export function countWords(markdown: string): number {
  const stripped = stripLinks(markdown).replace(/[|#*>`]/g, " ");
  return (stripped.match(/\b[\w'’₹%.,-]+\b/g) ?? []).length;
}

/**
 * Distinct external URLs the draft cites. Counted over the whole file rather than parsed out
 * of the "Sources and References" section: the house rule links every statistic inline to the
 * source supporting it, so the section is a listing of citations, not the set of them.
 *
 * Deduplicated because one source cited in three places is one source.
 */
export function countSources(markdown: string): number {
  const found = markdown.match(/https?:\/\/[^\s<>()[\]"']+/g) ?? [];
  const unique = new Set<string>();
  for (const url of found) {
    // A trailing . or , is sentence punctuation that ran into the URL, never part of it.
    unique.add(url.replace(/[.,;:]+$/, ""));
  }
  return unique.size;
}

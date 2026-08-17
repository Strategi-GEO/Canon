/** 0 -> "A", 25 -> "Z", 26 -> "AA", spreadsheet-style, for the uploaded-blog letters. */
function letter(n: number): string {
  let out = "";
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The fields a label is computed from. BlogSummary and BlogTableRow both satisfy it (uploaded is
 *  permissive: null and undefined both read as "not uploaded", i.e. AI-generated). */
export type LabelFacts = {
  topic_slug: string;
  created: string;
  uploaded?: boolean | null;
  roadmap_index: number | null;
};

/**
 * A blog's identifier, split by WHO wrote it.
 *
 * AI-generated blogs keep their ROADMAP ROW number (roadmap_index + 1). "Blog six" is roadmap row
 * six, the identity the sheet, the client, and the Create tab all share, so an engine blog reads
 * the same number everywhere. An engine blog on no current row has no number (null -> a dash),
 * exactly as before.
 *
 * Manually uploaded blogs are LETTERED A, B, C... in upload-date order, so a person-written blog
 * never wears a row number and is distinguishable at a glance. An uploaded article dropped onto a
 * roadmap row still gets a letter, not that row's number: the letters stay contiguous and the
 * numbers keep meaning "roadmap row". Three AI blogs on rows 1-3, an upload, then an AI blog on
 * row 4 read 1, 2, 3, A, 4.
 *
 * Returns a `topic_slug -> label` map (null = no number to show), so the table and a single detail
 * page read the SAME label from the SAME rule. Compute it from the FULL brand list, or the letter
 * order is wrong.
 */
export function blogLabels(blogs: LabelFacts[]): Map<string, string | null> {
  const labels = new Map<string, string | null>();
  // Letters: uploaded blogs only, in upload-date order (A = first uploaded).
  blogs
    .filter((blog) => blog.uploaded)
    .sort((a, b) => a.created.localeCompare(b.created))
    .forEach((blog, i) => labels.set(blog.topic_slug, letter(i)));
  // Numbers: every other blog wears its roadmap row, or a dash when it sits on no row.
  for (const blog of blogs) {
    if (blog.uploaded) continue;
    labels.set(blog.topic_slug, blog.roadmap_index != null ? String(blog.roadmap_index + 1) : null);
  }
  return labels;
}

/**
 * A slug read back as the sentence it was made from: "cafes-in-connaught-place" -> "Cafes in
 * connaught place".
 *
 * ONLY EVER A FALLBACK, and it is worth saying why it exists at all rather than just printing the
 * slug. This page knows the blog's real title from two places, the post's own `source_topic` and
 * the brand's blog listing, and both are reads that land a moment after the page does. What used
 * to fill that moment was the raw slug, hyphens and all, which reads as a broken record rather
 * than as a title still arriving. Word case is deliberately left alone past the first letter: a
 * slug has thrown away which words were capitalised, and title-casing every one of them invents
 * "Cafes In Connaught Place" and asserts a title nobody wrote.
 */
export function titleFromSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

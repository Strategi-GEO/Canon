import type { RoadmapRow } from "@/types";

/**
 * What a roadmap is ABOUT, derived from the sheet itself.
 *
 * The operator asked what the blogs are about and what the theme is "if any", and the honest
 * answer is whatever actually recurs across the topics. So this counts terms rather than
 * summarising: a summary sentence would have to come from a model, and a model asked to
 * characterise 25 topics will produce a confident sentence whether or not the topics have
 * anything in common. Counting cannot do that. When nothing recurs, the count is empty, and
 * "no single recurring theme" is the true answer rather than a failure to find one.
 */

/**
 * Terms that recur in every English sheet ever written, so their recurrence carries no
 * information about THIS roadmap. Kept to genuine function words: a content word that happens
 * to be dull ("guide", "buyers") is still evidence about the subject, and dropping it here
 * would be this file deciding what the roadmap is about instead of measuring it.
 */
const STOPWORDS = new Set([
  "a", "about", "after", "against", "all", "also", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "can", "could", "did", "do", "does", "doing", "down", "during",
  "each", "few", "for", "from", "further",
  "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how", "however",
  "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "like", "me", "more", "most", "my",
  "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our", "out",
  "over", "own",
  "per", "same", "she", "should", "so", "some", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "through", "to", "too",
  "under", "until", "up", "use", "using",
  "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "within", "would",
  "you", "your", "yours",
]);

export type ThemeTerm = {
  term: string;
  /**
   * How many TOPICS carry it, not how many times it was typed. A word repeated six times in
   * one row's covers text is that row being wordy; a word appearing in six different rows is
   * a theme. Only the second one is what was asked for, so occurrences within a row collapse.
   */
  topics: number;
  /** 2 for a phrase, 1 for a single word. Phrases outrank words at the same count. */
  words: 1 | 2;
};

/** Lowercase words, punctuation and CSV noise dropped. Digits stay attached to their word. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !/^\d+$/.test(word));
}

/** The terms one row contributes, deduped, because a row votes once for each term it holds. */
function termsOf(row: RoadmapRow): { unigrams: Set<string>; bigrams: Set<string> } {
  const tokens = tokenise(`${row.topic} ${row.covers}`);
  const unigrams = new Set<string>();
  const bigrams = new Set<string>();

  for (let i = 0; i < tokens.length; i += 1) {
    const word = tokens[i];
    if (!STOPWORDS.has(word)) {
      unigrams.add(word);
    }
    // A phrase spanning a stopword ("homes in the hills") is two ideas with grammar between
    // them, not one term, so only adjacent content words pair up.
    const next = tokens[i + 1];
    if (next && !STOPWORDS.has(word) && !STOPWORDS.has(next)) {
      bigrams.add(`${word} ${next}`);
    }
  }

  return { unigrams, bigrams };
}

function tally(sets: Set<string>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const set of sets) {
    for (const term of set) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The roadmap's recurring terms, strongest first. Empty when nothing recurs at all, which is
 * a real answer and the caller is expected to say so rather than render an empty box.
 *
 * Deterministic end to end: same rows in, same chips out, with ties broken by term rather
 * than by whatever order the Map happened to fill. Nothing here reaches the network.
 */
export function deriveTheme(rows: RoadmapRow[], limit = 6): ThemeTerm[] {
  const perRow = rows.map(termsOf);
  const bigramCounts = tally(perRow.map((r) => r.bigrams));
  const unigramCounts = tally(perRow.map((r) => r.unigrams));

  // Recurring means at least two topics. A term used once describes one blog, and the
  // question was what the roadmap as a whole is about.
  const bigrams: ThemeTerm[] = [...bigramCounts]
    .filter(([, topics]) => topics >= 2)
    .map(([term, topics]) => ({ term, topics, words: 2 }));

  // "Second home" is a better answer than "second" and "home" listed separately, so a word a
  // phrase genuinely speaks for does not also get its own chip. Spoken for means EVERY topic
  // carrying the word carries the phrase too, which is the equal count: drop the word and no
  // topic goes uncounted, because the chip that replaced it is in all the same rows.
  //
  // Membership alone was the wrong test and it deleted the roadmap's biggest terms. A phrase
  // in 3 topics claimed a word in 11, then ranked too low to be shown, so neither reached the
  // operator: "buy second" (3) took "buy" (11 of 25), "coffee country" (3) took "coffee" (6),
  // and the card promising the terms that recur showed "actually" (5) instead. A phrase can
  // only ever cover a subset of its words' topics, so equality is the whole of the rule and
  // no threshold has to be invented.
  const claimed = new Set(
    bigrams
      .flatMap(({ term, topics }) => term.split(" ").map((word) => ({ word, topics })))
      .filter(({ word, topics }) => unigramCounts.get(word) === topics)
      .map(({ word }) => word),
  );
  const unigrams: ThemeTerm[] = [...unigramCounts]
    .filter(([term, topics]) => topics >= 2 && !claimed.has(term))
    .map(([term, topics]) => ({ term, topics, words: 1 }));

  return [...bigrams, ...unigrams]
    .sort((a, b) => b.topics - a.topics || b.words - a.words || a.term.localeCompare(b.term))
    .slice(0, limit);
}

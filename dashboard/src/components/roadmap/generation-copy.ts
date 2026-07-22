/**
 * What a roadmap generation IS, in the operator's words, stated once.
 *
 * Three views describe this one job: the dialog that starts it, the Content Roadmap tab that
 * watches it, and the brand Overview that reports it is running. They have to agree, and the
 * expensive disagreement is about cost: a sentence that says "spends your quota" on one screen
 * and nothing on another teaches an operator that the button is free somewhere.
 *
 * Pure strings, no JSX, so the rules below are readable without mounting anything.
 */

/**
 * Why no bar and no percentage EVER appears on this job, written where anyone tempted to add
 * one will read it. A generation is a single agent session making an unknown number of tool
 * calls: it maps a site, scrapes what it finds, and runs as many DataForSEO calls as the
 * category needs. Nothing on the wire could give a bar a denominator, so a bar could only be
 * invented. The elapsed clock is the honest number, and it is the one every view shows.
 */
export const NO_DENOMINATOR =
  "There is no way to say how far along it is: it is one agent session making as many calls as the research needs, so the clock is the only honest number here.";

/** The durability promise, which is the whole reason the job lives in the engine. */
export const SURVIVES_REFRESH =
  "The session runs in the engine, so refreshing this page, closing the tab, or opening it somewhere else does not stop it or lose it.";

/**
 * What pressing the button actually costs, which is the one thing this dialog owes the
 * operator before they press it: live Firecrawl and DataForSEO calls, a long session, and the
 * operator's own Claude subscription quota, because that quota is personal and finite and
 * nothing else on this screen would tell them.
 */
export function costLine(brandName: string): string {
  return `This starts one long research session against live Firecrawl and DataForSEO data, and it spends your Claude subscription quota. It writes ${brandName}'s roadmap.csv when it succeeds, which is the file every blog for this brand is then written from.`;
}

/** What the session does, for the card that watches it rather than the one that starts it. */
export function workingLine(brandName: string): string {
  return `Claude Code is reading ${brandName}'s site through Firecrawl, pulling demand and competitor data from DataForSEO, and planning the rows.`;
}

/** The one line that explains what NOTES is for, taken from the prompt's own description of it. */
export const NOTES_HELP =
  "Optional. It overrides the prompt's defaults: use it for a geography lock, must-include topics, exclusions, named competitors, a different intent mix, or campaign context.";

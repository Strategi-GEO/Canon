/**
 * Never-claim is the only human set safety input at onboarding, so its copy lives in one
 * place and reads the same in the dialog and on the detail page.
 *
 * It exists because an agent can read a website and infer what a brand sells, but it cannot
 * infer what the brand is legally or commercially forbidden from saying. That gap is the
 * one a human has to close by hand.
 */
export const NEVER_CLAIM_EXPLAINER =
  "Claims the writer must never make about this brand, for example returns, yield, or performance promises. An agent can read a website and infer what a brand does, so this is the one thing it cannot infer. One rule per line.";

export const NEVER_CLAIM_PLACEHOLDER = `No returns, appreciation, yield, or ROI figures
No "guaranteed" or "assured" language
No possession or handover dates
No superlatives: best, first, only, number one`;

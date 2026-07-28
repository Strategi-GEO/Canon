/**
 * The vocabulary and rules for a CHANNEL POST's state, the separate-track cousin of blog-state.ts.
 * Kept apart on purpose: a channel post is not a blog, its states are fewer (no score, no
 * questions, no failure verdict), and its client words differ ("Ready to post", not "Ready to
 * review"). Like blog-state.ts, ONE state renders through two vocabularies (admin / client).
 */
import type { BlogState, StateTag, StateTone } from "./blog-state";
import type { ChannelPostState, RepurposeChannel } from "@/types";

export type { StateTone };

/** The ADMIN words: where the post is and who owes the next act. */
const ADMIN_TAGS: Record<ChannelPostState, StateTag> = {
  generating: {
    label: "Generating",
    tone: "busy",
    detail: "A run is generating this post. Nothing to do until it finishes.",
  },
  created: {
    label: "Created",
    tone: "owed",
    detail: "Generated and in internal review. Refine it, then send it to the client.",
  },
  sent: {
    label: "With client",
    tone: "waiting",
    detail: "Sent as ready to post. The client owes an approval or a change request.",
  },
  changes_requested: {
    label: "Changes requested",
    tone: "owed",
    detail: "The client asked for changes. Resolve or dismiss each one, then send again.",
  },
  approved: {
    label: "Approved",
    tone: "ship",
    detail: "The client approved this post. Mark it posted once it is live on the channel.",
  },
  posted: {
    label: "Posted",
    tone: "ship",
    detail: "Live on the channel.",
  },
};

/** The CLIENT words. `generating` and `created` are never shown (the post is internal then), but
 *  the map is total so a stray state can never crash a tag. */
const CLIENT_TAGS: Record<ChannelPostState, StateTag> = {
  generating: { label: "In progress", tone: "busy", detail: "Our team is working on this post." },
  created: { label: "In progress", tone: "busy", detail: "Our team is working on this post." },
  sent: {
    label: "Ready to post",
    tone: "owed",
    detail: "This post is with you. Approve it, or select any passage to ask for a change.",
  },
  changes_requested: {
    label: "Pending comments",
    tone: "waiting",
    detail: "We are working through your comments. You can add more, or approve at any time.",
  },
  approved: {
    label: "Approved",
    tone: "ship",
    detail: "You approved this post. It is locked now and ready for our team to post it.",
  },
  posted: { label: "Posted", tone: "ship", detail: "This post is live on the channel." },
};

export function channelTag(state: ChannelPostState, audience: "admin" | "client"): StateTag {
  return (audience === "admin" ? ADMIN_TAGS : CLIENT_TAGS)[state];
}

/**
 * The SOURCE-BLOG tag in the New tab, deliberately coarse: any post that exists reads "Created"
 * (yellow) until it is posted, then "Posted" (green). The finer states live on the post itself in
 * the Created tab, not on the blog it came from.
 */
export function channelBlogTag(state: ChannelPostState): StateTag {
  return state === "posted" ? ADMIN_TAGS.posted : ADMIN_TAGS.created;
}

/**
 * Which blogs can be turned into a channel post: any blog carrying a committed, evaluator-scored
 * draft. That includes `failed` (and its below-bar face): a failed blog holds the exact scored
 * blog.md that promote and edit operate on, so it is repurposable content. EXCLUDED are the states
 * with nothing settled to lift: `generating` (live, no committed post), `answers_submitted` (a
 * correction is mid-flight), `stopped` (discarded), `unknown` (unreadable), and `has_questions` (a
 * person owes an answer before the draft is trustworthy). Excluded blogs still show in the New tab
 * with their own tag, just never selectable.
 */
const REPURPOSABLE: ReadonlySet<BlogState> = new Set<BlogState>([
  "internal_review",
  "client_review",
  "changes_requested",
  "approved",
  "published",
  "failed",
]);

export function isRepurposable(state: BlogState): boolean {
  return REPURPOSABLE.has(state);
}

/** The channel's human label, for buttons and headings. */
export function channelLabel(channel: RepurposeChannel): string {
  return channel === "linkedin" ? "LinkedIn post" : "Medium article";
}

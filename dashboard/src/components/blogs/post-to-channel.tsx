"use client";

import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { RepurposeChannel } from "@/types";

/**
 * The always-on "actually post it" CTA. No channel here takes pre-filled body text through a URL
 * we can rely on, so the reliable path is the same for all four: copy the piece and open the
 * channel's composer in a new tab for a paste. One component, both surfaces: the admin review
 * page and the client's Ready-to-post view.
 *
 * X and Bluesky both DO have intent URLs that prefill text, and neither is used, deliberately.
 * A repurposed blog is a THREAD on X and may be one on Bluesky, and an intent URL can carry only
 * the first post; it would open a composer holding post one of nine and silently drop the rest,
 * which is worse than an empty composer beside the full text on screen. Copy-then-paste is
 * honest about what the operator still has to do.
 */
const COMPOSE: Record<RepurposeChannel, { name: string; url: string }> = {
  linkedin: { name: "LinkedIn", url: "https://www.linkedin.com/feed/?shareActive=true" },
  medium: { name: "Medium", url: "https://medium.com/new-story" },
  bluesky: { name: "Bluesky", url: "https://bsky.app/" },
  x: { name: "X", url: "https://x.com/compose/post" },
};

export function PostToChannel({
  channel,
  content,
  size = "sm",
}: {
  channel: RepurposeChannel;
  content: string;
  size?: "sm" | "default";
}) {
  const { name, url } = COMPOSE[channel];
  async function go() {
    try {
      await navigator.clipboard.writeText(content);
      toast.success(`Copied. Paste it into ${name}.`);
    } catch {
      // Clipboard denied: still open the composer; the text is on screen to copy by hand.
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return (
    <Button size={size} onClick={() => void go()}>
      <ExternalLink data-icon="inline-start" aria-hidden />
      Post to {name}
    </Button>
  );
}

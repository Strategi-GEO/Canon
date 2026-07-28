"use client";

import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { RepurposeChannel } from "@/types";

/**
 * The always-on "actually post it" CTA. Neither LinkedIn nor Medium takes pre-filled body text
 * through a URL, so the reliable path is to copy the piece and open the channel's composer in a
 * new tab for a paste. One component, both surfaces: the admin review page and the client's
 * Ready-to-post view.
 */
const COMPOSE: Record<RepurposeChannel, { name: string; url: string }> = {
  linkedin: { name: "LinkedIn", url: "https://www.linkedin.com/feed/?shareActive=true" },
  medium: { name: "Medium", url: "https://medium.com/new-story" },
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

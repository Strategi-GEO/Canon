"use client";

import Link from "next/link";
import { MessageCircleQuestion } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import type { DiscoverySet } from "@/types";

/**
 * The Overview's discovery summary: how many questions are drafted, sent and answered.
 *
 * It is a POINTER, not a control. Generating spends real quota and sending puts model-written
 * text in front of a client, so both presses live on the Questions tab where the questions
 * themselves are readable. A generate button here would let someone spend a session on a brand
 * whose form they have not looked at.
 *
 * It renders a compact empty state rather than nothing, because "no questions yet" is the state
 * this card most needs to report: the whole point of the feature is that a brand nobody has asked
 * is a brand whose fact base is missing whatever its website never said.
 */
export function DiscoveryCard({
  orgSlug,
  brandSlug,
}: {
  orgSlug: string;
  brandSlug: string;
}) {
  const [data, setData] = React.useState<DiscoverySet | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    // A failed read costs this card its numbers, never the page its render, which is how every
    // other summary card on this Overview treats its own fetch.
    api.discovery(brandSlug, controller.signal).then(
      (res) => setData(res),
      () => setData(null),
    );
    return () => controller.abort();
  }, [brandSlug]);

  const href = brandHref(orgSlug, brandSlug, "/questions");
  const total = data === null ? 0 : data.questions.length;

  return (
    <Card>
      <CardContent>
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-medium">Questions</h3>
        </div>

        {total === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing asked yet. Canon can read this brand&apos;s site for what it does not say, and
            turn the gaps into questions the client answers.
          </p>
        ) : (
          <dl className="mt-3 space-y-1.5 text-sm">
            <Row label="Answered" value={data?.answered ?? 0} />
            <Row label="With the client" value={data?.sent ?? 0} />
            <Row label="Waiting on your review" value={data?.draft ?? 0} />
          </dl>
        )}

        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link href={href}>{total === 0 ? "Ask the client" : "Open questions"}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums font-medium">{value}</dd>
    </div>
  );
}

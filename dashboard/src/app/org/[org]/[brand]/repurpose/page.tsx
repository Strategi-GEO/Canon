"use client";

import { Recycle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { BrandRoute } from "@/components/shell/brand-route";

/**
 * A placeholder with a promise, not a broken door: the tab exists so the operator learns
 * where repurposing will live, and the page says plainly that it is not here yet. No CTA
 * on purpose, because a button that leads nowhere teaches the operator not to press things.
 */
export default function RepurposePage() {
  return (
    <BrandRoute>
      {() => (
        <div className="mx-auto w-full max-w-md">
          <Card>
            <CardContent className="py-12 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
                <Recycle className="size-5 text-muted-foreground" aria-hidden />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                Repurpose is coming soon
              </p>
              <p className="mx-auto mt-2 max-w-sm text-xs text-muted-foreground">
                It will turn shipped blogs into social posts, emails, and briefs, so one
                researched piece feeds every channel.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </BrandRoute>
  );
}

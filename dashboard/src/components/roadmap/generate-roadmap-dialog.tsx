"use client";

import * as React from "react";
import { Loader2, Map as MapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { FieldError } from "@/components/clients/engine-error";
import {
  NOTES_HELP,
  NO_DENOMINATOR,
  SURVIVES_REFRESH,
  costLine,
  type MockReason,
} from "@/components/roadmap/generation-copy";
import type { RoadmapGenJob } from "@/types";

/** The engine's own bounds, mirrored so the form refuses what the 422 would refuse anyway. */
const MIN_PIECES = 1;
const MAX_PIECES = 50;

/**
 * The prompt's intent mix is specified AT ten: six commercial, three informational, one
 * navigational. Any other default would silently ask for a mix the prompt then has to
 * improvise, so ten is the honest number rather than a round one.
 */
const DEFAULT_PIECES = "10";

/** http(s) only, which is the same thing the engine's 422 checks. */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Takes the three inputs the prompt substitutes, then starts the generation.
 *
 * It closes the moment the engine accepts. The 202 comes back in single digit milliseconds
 * and the work then lives in the engine, so there is nothing for a dialog to sit and watch:
 * the tab behind it owns the running job, and holding a modal over a twenty minute session
 * would trap the operator in front of a clock.
 */
export function GenerateRoadmapDialog({
  brandSlug,
  brandName,
  brandDomain,
  mock,
  locked,
  lockedReason,
  onStarted,
  onRefused,
}: {
  brandSlug: string;
  brandName: string;
  /**
   * The brand's own `domain`, straight off the client record, and the field's prefill.
   *
   * Prefilling is load bearing rather than a convenience: this is the site the WHOLE roadmap
   * gets researched from, and a typed typo does not fail, it quietly researches the wrong
   * company and spends a full session doing it.
   */
  brandDomain: string;
  /** Why this brand's runs are mock, or null when a press spends real quota. */
  mock: MockReason | null;
  /** True when the engine would 409 the start. The reason is said rather than discovered. */
  locked?: boolean;
  lockedReason?: string;
  /** The 202's job, handed to the view that watches it. */
  onStarted: (job: RoadmapGenJob) => void;
  /**
   * A 409 means the engine already has a generation for this brand and refused to start a
   * second. The running one is what the operator needs on screen, and the engine is the place
   * to ask for it, so this asks the owner to re-read rather than parsing the refusal body.
   */
  onRefused: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [brandUrl, setBrandUrl] = React.useState(brandDomain);
  const [pieceCount, setPieceCount] = React.useState(DEFAULT_PIECES);
  const [notes, setNotes] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  function reset() {
    setBrandUrl(brandDomain);
    setPieceCount(DEFAULT_PIECES);
    setNotes("");
    setError(null);
  }

  const count = Number.parseInt(pieceCount, 10);
  const urlOk = isHttpUrl(brandUrl.trim());
  const countOk = Number.isInteger(count) && count >= MIN_PIECES && count <= MAX_PIECES;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.generateRoadmap(brandSlug, {
        brand_url: brandUrl.trim(),
        piece_count: count,
        // Always sent, "" when blank: the prompt substitutes it either way.
        notes: notes.trim(),
      });
      setOpen(false);
      reset();
      onStarted(job);
    } catch (cause) {
      const failure = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      setError(failure);
      if (failure.status === 409) {
        onRefused();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {/* Outline, not the accent. Upload is still THE action on the empty state: it is
            instant and free, and this one is a long session that spends quota, so it does not
            get the styling that says "press me by default". */}
        <Button size="sm" variant="outline" disabled={locked} title={locked ? lockedReason : undefined}>
          <MapIcon data-icon="inline-start" aria-hidden />
          Generate roadmap
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate a content roadmap for {brandName}</DialogTitle>
          <DialogDescription>
            One agent session researches the brand, its market and its competitors, then writes
            the roadmap CSV the factory picks topics from. It reads everything already uploaded
            for {brandName} first: the client facts, the canonical facts, and every file in
            Resources.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="gen-brand-url">Brand URL</Label>
            <Input
              id="gen-brand-url"
              type="url"
              value={brandUrl}
              onChange={(e) => setBrandUrl(e.target.value)}
              placeholder="https://example.com/"
              required
              autoComplete="off"
              aria-invalid={brandUrl.trim() !== "" && !urlOk ? true : undefined}
              className="mt-1.5"
            />
            {/* The stake is stated, because the failure here is silent: a wrong URL produces a
                complete, confident roadmap for somebody else's company. */}
            <p className="mt-1 text-xs text-muted-foreground">
              Prefilled from {brandName}&apos;s own domain. The whole roadmap is researched from
              this site, so a typo here researches the wrong company rather than failing.
            </p>
          </div>

          <div>
            <Label htmlFor="gen-piece-count">Pieces</Label>
            <Input
              id="gen-piece-count"
              type="number"
              inputMode="numeric"
              min={MIN_PIECES}
              max={MAX_PIECES}
              step={1}
              value={pieceCount}
              onChange={(e) => setPieceCount(e.target.value)}
              required
              aria-invalid={pieceCount !== "" && !countOk ? true : undefined}
              className="machine mt-1.5 w-28"
            />
            {/* One string rather than prose interleaved with expressions. JSX drops the space
                after an expression in some positions and keeps it in others, and this sentence
                lost the one after the default and shipped "The default of 10is what" to the
                browser. A template literal has no whitespace rules to lose. */}
            <p className="mt-1 text-xs text-muted-foreground">
              {`How many topics to plan, ${MIN_PIECES} to ${MAX_PIECES}. The default of ${DEFAULT_PIECES} is what the prompt's intent mix is written for: 6 commercial, 3 informational, 1 entity FAQ. The agent delivers fewer if fewer topics survive its own gates, and says why.`}
            </p>
          </div>

          <div>
            <Label htmlFor="gen-notes">Notes</Label>
            <p className="mt-1 text-xs text-muted-foreground">{NOTES_HELP}</p>
            <Textarea
              id="gen-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Lock to Bengaluru buyers. Do not plan anything on returns or appreciation. Treat Kodagu resorts as the competitive set."
              className="mt-1.5"
            />
          </div>

          {/* What the press costs, immediately above the button that charges it. This is the
              last thing read before the click, which is the only place it can do its job. */}
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-foreground">{costLine(mock, brandName)}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {SURVIVES_REFRESH} {NO_DENOMINATOR}
            </p>
          </div>

          {locked && lockedReason ? (
            <p className="text-xs leading-relaxed text-review">{lockedReason}</p>
          ) : null}

          {error ? <FieldError error={error} /> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting || locked || !urlOk || !countOk}>
              {submitting ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : null}
              Generate roadmap
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

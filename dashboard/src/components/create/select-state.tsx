"use client";

import * as React from "react";
import Link from "next/link";
// Map is aliased: the bare name shadows the JS Map constructor, and this file builds one.
import {
  ArrowRight,
  CircleDot,
  Map as MapIcon,
  Play,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { useHotkey, useModLabel } from "@/lib/use-hotkey";
import { formatCount } from "@/lib/format";
import { ENGINE_SLOTS } from "@/lib/sessions";
import { RoadmapTable } from "@/components/create/roadmap-table";
import { NoFactBaseDialog } from "@/components/create/no-fact-base-dialog";
import { SessionInstructionsDialog } from "@/components/create/session-instructions-dialog";
import { EngineErrorNote, detailText } from "@/components/create/engine-error";
import { seedsFor, type Seed } from "@/components/create/use-run-stream";
import { useRowSelection } from "@/components/create/use-row-selection";
import { isSelectable, resolveRowState } from "@/components/create/row-status";
import type {
  Duplicate,
  GenerateBody,
  IncompleteRow,
  RoadmapResponse,
} from "@/types";

/**
 * Picking topics for ONE brand. Every input arrives as a prop: this component never reads the
 * active brand from a context or from the URL, because a component that guesses its own brand
 * is how a blog gets written against the wrong fact base.
 */
export function SelectState({
  brandSlug,
  brandName,
  brandInstructions,
  brandHref,
  roadmapHref,
  resourcesHref,
  hasCanonicalFacts,
  resourceCount,
  roadmap,
  roadmapError,
  loading,
  live,
  failed,
  belowBar,
  needsReview,
  runsUnavailable,
  liveRunId,
  preselectSlugs,
  onUploaded,
  onWatch,
  onStarted,
}: {
  brandSlug: string;
  brandName: string;
  /** The brand's standing blog instructions, shown read-only in the Generate dialog. "" = none. */
  brandInstructions: string;
  /** The brand overview, for checking facts and resources. The route owns this URL. */
  brandHref: string;
  /** The Content Roadmap tab, which owns getting and deleting the sheet this page reads. */
  roadmapHref: string;
  /** The Resources tab, where the fact base warning below sends an operator who has none. */
  resourcesHref: string;
  /**
   * Whether this brand already has a canonical-facts.md, from the client record the route
   * already holds. False means this run builds one first, before any blog.
   */
  hasCanonicalFacts: boolean;
  /** Files in this brand's Resources/, from the same client record. The fact base's input. */
  resourceCount: number;
  roadmap: RoadmapResponse | null;
  roadmapError: ApiError | null;
  loading: boolean;
  /** Topic slugs in a live run right now, from GET /api/runs and the SSE stream. */
  live: ReadonlySet<string>;
  /** Topic slugs whose last terminal status was failed AND scored under BELOW_BAR_FLOOR. */
  failed: ReadonlySet<string>;
  /** Topic slugs that ended failed but landed in the BELOW_BAR_FLOOR to SHIP_BAR-1 band:
   *  yellow "below bar", not red. Named by the constants because the band has moved once. */
  belowBar: ReadonlySet<string>;
  /** Topic slugs whose blog is held for the operator's answer (status needs_review). */
  needsReview: ReadonlySet<string>;
  /** True when /api/runs could not be reached, so whether a run is live is unknown. */
  runsUnavailable: boolean;
  /** The live run for this brand, or null. Lets the operator jump back to watching it. */
  liveRunId: string | null;
  /** Topics arriving from a retry, ticked on mount so retrying stays one click. */
  preselectSlugs?: readonly string[];
  /** An article was uploaded against one row: the caller refetches the roadmap and the blogs. */
  onUploaded: () => void;
  onWatch: () => void;
  /** sessionInstructions is what the operator typed in the Generate dialog, "" when they skipped. */
  onStarted: (runId: string, seeds: Seed[], sessionInstructions: string) => void;
}) {
  const rows = React.useMemo(() => roadmap?.rows ?? [], [roadmap]);

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  // The fact base confirm, open only when a press earns it. See `submit` below.
  const [warning, setWarning] = React.useState(false);
  // The session-instructions dialog, opened by every Generate press. See `submit` below.
  const [sessionOpen, setSessionOpen] = React.useState(false);
  // Bumped on every open so the dialog REMOUNTS with a blank box: this run's instructions are
  // this run's, and a component that stayed mounted would carry the last press's text forward.
  const [sessionToken, setSessionToken] = React.useState(0);
  // This run's instructions, held between the dialog answering and the fact-base warning
  // resolving, so Proceed-anyway carries them through. A ref, not state: it steers the next
  // submit and must not itself cause a render.
  const pendingSession = React.useRef("");
  const [duplicates, setDuplicates] = React.useState<Map<number, Duplicate>>(new Map());
  const [incomplete, setIncomplete] = React.useState<Map<number, string[]>>(new Map());
  // Filled by the table's rows. A 409 or a 422 scrolls to the offending row by index.
  const rowRefs = React.useRef<Map<number, HTMLElement>>(new Map());

  const facts = React.useMemo(
    () => ({ live, failed, belowBar, needsReview, duplicates }),
    [live, failed, belowBar, needsReview, duplicates],
  );

  // What a tick may reach HERE: rows that can be written. The rewrite panel answers this
  // question differently, which is why the predicate is the hook's input rather than baked in.
  const eligible = React.useCallback(
    (row: (typeof rows)[number]) => isSelectable(resolveRowState(row, facts)),
    [facts],
  );

  // A retry arrives already ticked. The parent remounts this on retry, so the initialiser is
  // the whole mechanism: no effect that would fight the operator's own clicks afterwards.
  const { selected, setSelected, toggle, toggleAll, eligibleRows: selectable } = useRowSelection(
    rows,
    eligible,
    () => {
      if (!preselectSlugs || preselectSlugs.length === 0) {
        return new Set();
      }
      const wanted = new Set(preselectSlugs);
      return new Set(
        (roadmap?.rows ?? []).filter((r) => wanted.has(r.topic_slug)).map((r) => r.index),
      );
    },
  );

  const scrollTo = React.useCallback((index: number) => {
    const node = rowRefs.current.get(index);
    if (!node) {
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }, []);

  const uploadId = roadmap?.upload_id ?? null;

  const generate = React.useCallback(async (sessionInstructions: string) => {
    setSubmitting(true);
    setError(null);
    setDuplicates(new Map());
    setIncomplete(new Map());

    const session = sessionInstructions.trim();
    const body: GenerateBody = {
      rows: [...selected].sort((a, b) => a - b),
      // The engine re-reads the archived upload instead of trusting rows the browser sends
      // back, so upload_id has to survive from the upload all the way to this submit. Drop
      // it and the engine scores a different sheet than the one on screen. A roadmap loaded
      // from disk carries no upload_id, and then the engine reads roadmap.csv: also correct,
      // because that is the same sheet this table was built from.
      ...(uploadId ? { upload_id: uploadId } : {}),
      // Only sent when non-empty: a blank box is an ordinary answer, and omitting the key keeps
      // the run byte-for-byte the same as before this dialog existed.
      ...(session ? { session_instructions: session } : {}),
    };

    try {
      const accepted = await api.generate(brandSlug, body);
      onStarted(accepted.run_id, seedsFor(accepted.topics, rows), session);
    } catch (cause) {
      const apiError =
        cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      setError(apiError);

      if (apiError.status === 409) {
        // Stay put. Nothing is auto-deselected: the operator decides, and the banner below
        // turns that decision into one click rather than a hunt through 25 rows.
        const refused = readDuplicates(apiError);
        setDuplicates(new Map(refused.map((d) => [d.index, d])));
        if (refused.length > 0) {
          requestAnimationFrame(() => scrollTo(refused[0].index));
        }
      }

      if (apiError.status === 422) {
        const bad = readIncomplete(apiError);
        setIncomplete(new Map(bad.map((r) => [r.index, r.missing])));
        if (bad.length > 0) {
          requestAnimationFrame(() => scrollTo(bad[0].index));
        }
      }
    } finally {
      setSubmitting(false);
    }
  }, [brandSlug, onStarted, rows, scrollTo, selected, uploadId]);

  /**
   * A brand with no fact base AND no resources gets the question first. Both halves matter: the
   * engine builds canonical-facts.md only when the file is missing, and it builds it mainly from
   * the resources, so a brand with either one has already answered this. Asking anyway would
   * teach the operator to click past a dialog that is usually noise, which is how the one that
   * mattered gets clicked past too.
   *
   * Both facts come off the client record the route already holds, so this costs no fetch and
   * cannot disagree with what the brand's own pages report.
   */
  const needsFactBase = !hasCanonicalFacts && resourceCount === 0;

  /**
   * What pressing Generate MEANS, in one place, because there are two ways to press it.
   *
   * The hotkey and the button both come through here. Both open the session-instructions dialog
   * first: it is the one moment to shape this run, and asking on the button alone would let the
   * hotkey skip a question the operator is meant to answer every time.
   */
  const submit = React.useCallback(() => {
    setSessionToken((token) => token + 1);
    setSessionOpen(true);
  }, []);

  /**
   * The session dialog answered. Hold this run's instructions and run the SAME submit as before:
   * the fact-base warning still gates it, and its Proceed-anyway carries the held text through.
   * An empty answer is ordinary, so nothing here branches on whether instructions were typed.
   */
  const proceed = React.useCallback(
    (sessionInstructions: string) => {
      setSessionOpen(false);
      pendingSession.current = sessionInstructions;
      if (needsFactBase) {
        setWarning(true);
        return;
      }
      void generate(sessionInstructions);
    },
    [needsFactBase, generate],
  );

  const canGenerate = !submitting && selected.size > 0;
  const modLabel = useModLabel();

  // The roadmap is a keyboard surface: tab to a row, space to tick, and submit without
  // reaching for the mouse. Enter alone would fire while ticking checkboxes, so it is modified.
  useHotkey("mod+enter", submit, { enabled: canGenerate });

  if (loading) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (roadmapError && roadmapError.status === 404) {
    return (
      <NoRoadmap
        brandName={brandName}
        brandHref={brandHref}
        roadmapHref={roadmapHref}
      />
    );
  }

  if (roadmapError) {
    return (
      <Card className="border-fail/25 bg-fail-bg">
        <CardContent className="py-8 text-center">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-fail/10">
            <TriangleAlert className="size-5 text-fail" aria-hidden />
          </div>
          <p className="mt-3 text-sm font-medium text-fail">
            {/* An engine that never answered and an engine that refused are different
                problems with different fixes: one is "start the engine", the other is "read
                what it said". Naming them the same would send an operator hunting the wrong one. */}
            {roadmapError.isOffline
              ? "Cannot reach the engine"
              : "The engine refused the roadmap request"}
          </p>
          <p className="machine mx-auto mt-2 max-w-md text-xs wrap-break-word text-fail/80">
            {detailText(roadmapError)}
          </p>
          {roadmapError.isOffline ? (
            <p className="mx-auto mt-2 max-w-md text-xs text-fail/80">
              The engine runs locally and the browser only reads from it. Nothing here starts
              it, and any run already going is unaffected by this page failing to reach it.
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  if (!roadmap) {
    return (
      <NoRoadmap
        brandName={brandName}
        brandHref={brandHref}
        roadmapHref={roadmapHref}
      />
    );
  }

  const refusedIndices = [...duplicates.keys()].filter((index) => selected.has(index));

  return (
    <div className="w-full">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Create blogs
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every row below is a blog the factory will write for {brandName}. Tick the ones
            you want.
          </p>
        </div>
        {/*
          Uploading and generating a roadmap used to sit here. They live on the Content Roadmap
          tab now and nowhere else, because getting a roadmap and picking topics out of one are
          two jobs, and putting a destructive action (swapping the topic list) next to the table
          an operator is mid-selection on was how the sheet changed under them.

          Outline, not accent: Generate is this page's one accent action. This is a way out to
          the list, not the thing to do here.
        */}
        <Button size="sm" variant="outline" asChild>
          <Link href={roadmapHref}>
            View content roadmap
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      </div>

      {runsUnavailable ? (
        <Card className="mb-4 border-review/25 bg-review-bg">
          <CardContent className="flex items-start gap-1.5 py-3">
            <WifiOff className="mt-px size-3.5 shrink-0 text-review" aria-hidden />
            <p className="text-xs leading-relaxed text-review">
              The engine did not answer when this page asked whether a run is live, so no row
              can be shown as generating. A topic already running is still refused at submit,
              so nothing can be started twice. Refresh to ask again.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {liveRunId ? (
        <Card className="mb-4 border-review/25 bg-review-bg">
          <CardContent className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-56 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium text-review">
                <CircleDot className="size-3.5 shrink-0" aria-hidden />A run is live for{" "}
                {brandName}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Its topics are yellow below and cannot be picked again. Everything else stays
                selectable, and the engine starts each one as a slot frees.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={onWatch}>
              Watch the run
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {refusedIndices.length > 0 ? (
        <DuplicateWall
          duplicates={refusedIndices.map((index) => duplicates.get(index)!)}
          onDeselect={() => {
            setSelected((current) => {
              const next = new Set(current);
              for (const index of refusedIndices) {
                next.delete(index);
              }
              return next;
            });
            // The refusal is answered, so its banner goes. The duplicates map stays: it is the
            // engine's own account of those rows, and it is what keeps them correctly locked.
            setError(null);
          }}
        />
      ) : null}

      <Card className="mb-4 p-0">
        {/* The brief-explainer paragraph was removed on request so the table starts at its
            headings. The archived note stays, but only draws its bar when there is one, so the
            common case has no empty strip above the table. */}
        {roadmap.archived ? (
          <div className="border-b border-border px-4 py-2.5">
            <p className="machine text-xs wrap-break-word text-muted-foreground/70">
              archived: {roadmap.archived}
            </p>
          </div>
        ) : null}

        {roadmap.warnings.length > 0 ? (
          <ul className="border-b border-border bg-review-bg px-4 py-2.5">
            {roadmap.warnings.map((warning) => (
              <li key={warning} className="machine text-xs text-review">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}

        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            This roadmap parsed with no rows in it. Upload a sheet with topics in it.
          </p>
        ) : (
          <RoadmapTable
            rows={rows}
            facts={facts}
            selected={selected}
            incomplete={incomplete}
            onToggle={toggle}
            onToggleAll={toggleAll}
            upload={{ brandSlug, onUploaded }}
            rowRefs={rowRefs}
          />
        )}

        <div className="border-t border-border px-4 py-2.5">
          {/* Not guessable, and the operator asked for it to be said: a green row is locked
              because the blog exists on disk, and the disk is what the engine reads. */}
          <p className="text-xs text-muted-foreground">
            The factory treats the filesystem as the truth: delete a generated blog&apos;s
            output folder and its topic is free to generate again. Shift-click a second
            checkbox to tick everything between the two.
          </p>
        </div>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="min-w-56 flex-1">
            <p className="text-xs text-muted-foreground">
              Real run. Each blog researches live sources and costs API credits.
            </p>
            {error ? <EngineErrorNote error={error} className="mt-2" /> : null}
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <SelectionSummary
              selectedCount={selected.size}
              selectableCount={selectable.length}
              brandName={brandName}
            />
            {/* Never disabled by the fact base warning. The operator asked to be warned, not
                blocked, and a Generate that refuses to press is a dead end on the one page that
                exists to press it. */}
            <Button
              onClick={submit}
              // Left enabled after a refusal so deselect and retry is one click.
              disabled={!canGenerate}
              title={canGenerate ? `${modLabel} Enter` : undefined}
            >
              <Play aria-hidden data-icon="inline-start" />
              {submitting ? "Starting" : "Generate"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Asked first, before the fact-base warning: every Generate press answers this. It hands
          back this run's instructions and `proceed` runs the same submit the button always did. */}
      <SessionInstructionsDialog
        key={sessionToken}
        open={sessionOpen}
        onOpenChange={setSessionOpen}
        brandName={brandName}
        brandInstructions={brandInstructions}
        selectedCount={selected.size}
        onConfirm={proceed}
      />

      {/* Proceed submits exactly what the button would have submitted: the selection, the
          upload_id, this run's instructions, the same error handling on this page. The dialog
          decides whether to ask, never what to send. */}
      <NoFactBaseDialog
        open={warning}
        onOpenChange={setWarning}
        brandName={brandName}
        resourcesHref={resourcesHref}
        onProceed={() => void generate(pendingSession.current)}
      />
    </div>
  );
}

/**
 * What Generate is about to do, in rows and in blogs.
 *
 * A count alone ("3 selected") does not say what happens next, and this button spends real
 * API credits on a real brand. Saying it plainly is cheaper than an operator finding out.
 */
function SelectionSummary({
  selectedCount,
  selectableCount,
  brandName,
}: {
  selectedCount: number;
  selectableCount: number;
  brandName: string;
}) {
  return (
    <div className="text-right text-xs text-muted-foreground" aria-live="polite">
      <p>
        <span className="machine text-foreground">{formatCount(selectedCount)}</span> of{" "}
        <span className="machine">{formatCount(selectableCount)}</span> selectable
      </p>
      {selectedCount > 0 ? (
        <p className="mt-0.5">
          Writes <span className="machine">{formatCount(selectedCount)}</span>{" "}
          {selectedCount === 1 ? "blog" : "blogs"} for {brandName}, {ENGINE_SLOTS} at a time.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The engine refused the submit because rows in it already exist.
 *
 * The refusal is whole: not one blog started, so this is a wall and not a partial failure.
 * It reads as a fact rather than a telling off, because picking a topic that shipped last
 * week off a 25 row sheet is an ordinary thing to do, and the operator cannot see the ledger.
 * The rows themselves go green or yellow, per the colour rule that green means the blog
 * already exists; the red here belongs to the refusal, not to the rows.
 */
function DuplicateWall({
  duplicates,
  onDeselect,
}: {
  duplicates: Duplicate[];
  onDeselect: () => void;
}) {
  const generated = duplicates.filter((d) => d.reason === "already_generated");
  const inFlight = duplicates.filter((d) => d.reason === "in_flight");

  return (
    <Card className="mb-4 border-fail/25 bg-fail-bg">
      <CardContent className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-56 flex-1">
          <p className="text-sm font-medium text-fail">
            The engine refused this submit. Nothing started.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            <span className="machine">{duplicates.length}</span>{" "}
            {duplicates.length === 1 ? "row" : "rows"} already exist for this brand, so the
            whole submit was refused rather than half a batch running. Deselect them and the
            rest go straight through.
          </p>
          <ul className="mt-2 space-y-1">
            {generated.map((d) => (
              <li key={d.topic_slug} className="text-xs text-muted-foreground">
                <span className="machine text-foreground">{d.topic_slug}</span> shipped
                {d.score !== null ? (
                  <>
                    {" "}
                    at <span className="machine">{d.score}</span>
                  </>
                ) : null}
                . Its blog is on disk.
              </li>
            ))}
            {inFlight.map((d) => (
              <li key={d.topic_slug} className="text-xs text-muted-foreground">
                <span className="machine text-foreground">{d.topic_slug}</span> is generating
                right now in a live run.
              </li>
            ))}
          </ul>
        </div>
        <Button variant="outline" size="sm" onClick={onDeselect}>
          Deselect the {duplicates.length} refused {duplicates.length === 1 ? "row" : "rows"}
        </Button>
      </CardContent>
    </Card>
  );
}

function NoRoadmap({
  brandName,
  brandHref,
  roadmapHref,
}: {
  brandName: string;
  /** The brand overview. */
  brandHref: string;
  /** The Content Roadmap tab: the one place a roadmap is uploaded or generated. */
  roadmapHref: string;
}) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardContent className="py-12 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <MapIcon className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">
          {brandName} has no content roadmap yet
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The roadmap is the brief: every blog starts as a row in it. There is nothing to pick
          here until one exists, so this page waits on the Content Roadmap tab rather than
          showing an empty table.
        </p>
        {/*
          A link, not an uploader. The upload lives on the Content Roadmap tab and nowhere
          else, by the operator's instruction, and duplicating it here would put two ways to
          define a brand's topic list in two places that could disagree.
        */}
        <Button size="sm" className="mt-4" asChild>
          <Link href={roadmapHref}>
            Go to Content Roadmap
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
        <p className="mt-4 text-xs text-muted-foreground">
          <Link href={brandHref} className="underline underline-offset-2 hover:text-foreground">
            Open {brandName}
          </Link>{" "}
          to check the facts and resources its blogs are written from.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The 409 body carries the refused rows. The engine nests them as
 * {detail: {detail: "...", duplicates: [...]}}, and api.ts hands back the inner object as
 * `detail`, so that is where the array actually is. The raw body is checked too rather than
 * betting the whole red row treatment on one nesting level staying put.
 */
function readDuplicates(error: ApiError): Duplicate[] {
  for (const candidate of [error.detail, error.body]) {
    if (candidate && typeof candidate === "object") {
      const list = (candidate as { duplicates?: unknown }).duplicates;
      if (Array.isArray(list)) {
        return list.filter(
          (d): d is Duplicate => typeof (d as Duplicate)?.index === "number",
        );
      }
    }
  }
  return [];
}

/** The 422 body puts the per-row missing list in detail. */
function readIncomplete(error: ApiError): IncompleteRow[] {
  if (Array.isArray(error.detail)) {
    return (error.detail as unknown[]).filter(
      (r): r is IncompleteRow =>
        typeof (r as IncompleteRow)?.index === "number" &&
        Array.isArray((r as IncompleteRow)?.missing),
    );
  }
  return [];
}

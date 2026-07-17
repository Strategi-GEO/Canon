"use client";

import * as React from "react";
import { CircleDot, FileSpreadsheet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useOrgs } from "@/lib/orgs-context";
import { useRuns } from "@/lib/runs-context";
import { useRoadmap } from "@/lib/use-roadmap";
import { useRoadmapGen } from "@/lib/use-roadmap-gen";
import { cn } from "@/lib/utils";
import { EngineDown } from "@/components/clients/engine-error";
import { RoadmapUploader } from "@/components/create/roadmap-uploader";
import { DeleteRoadmapDialog } from "@/components/roadmap/delete-roadmap-dialog";
import { GenerateRoadmapDialog } from "@/components/roadmap/generate-roadmap-dialog";
import { mockReasonOf, type MockReason } from "@/components/roadmap/generation-copy";
import { RoadmapGeneration } from "@/components/roadmap/roadmap-generation";
import { RoadmapPreviewDialog } from "@/components/roadmap/roadmap-preview-dialog";
import { roadmapStats } from "@/components/roadmap/roadmap-stats";
import { deriveTheme } from "@/components/roadmap/roadmap-theme";
import type { BlogSummary } from "@/types";

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * The roadmap tab: what this brand's roadmap is, where it stands, and the two things that can
 * be done to it.
 *
 * There is deliberately no table here. This tab used to render the rows, and Create Blogs
 * renders the same rows to pick from, so the two tabs were the same page with a different
 * button at the top and an operator could not tell which one they were on. The rows belong
 * where they are acted on. What belongs HERE is the question the rows cannot answer by being
 * listed: how many are there, how many are written, how many are left, and what they are all
 * about. The file itself is one click away in Preview, which is where a grid is the right
 * answer rather than the default one.
 */
export function RoadmapOverview({
  brandSlug,
  brandName,
  brandDomain,
  demoMode,
}: {
  brandSlug: string;
  brandName: string;
  /**
   * The brand's own domain, from the client record the route already holds. It prefills the
   * generation dialog's BRAND_URL, which is the site the whole roadmap gets researched from.
   */
  brandDomain: string;
  /** A demo brand is mock in every environment, so what a Generate press costs depends on it. */
  demoMode: boolean;
}) {
  const roadmap = useRoadmap(brandSlug);
  const gen = useRoadmapGen(brandSlug);
  const { geoMock } = useOrgs();
  const [blogs, setBlogs] = React.useState<BlogSummary[]>([]);

  React.useEffect(() => {
    const controller = new AbortController();
    api.blogs(brandSlug, controller.signal).then(
      (data) => setBlogs(data.blogs),
      () => {
        // Losing this costs the tab its blog counts, not the operator their roadmap. The topic
        // count, the prompts and the theme all come from the roadmap payload and still render.
      },
    );
    return () => controller.abort();
  }, [brandSlug]);

  // ONE poll for the whole app, already running for the topbar indicator, so this costs no
  // fetch. It answers the only question this tab needs it for: whether the engine will refuse
  // a delete right now.
  const { runs } = useRuns();
  const liveRun = runs.find((run) => run.live && run.client === brandSlug) ?? null;

  const rows = React.useMemo(() => roadmap.data?.rows ?? [], [roadmap.data]);
  const stats = React.useMemo(() => roadmapStats(rows, blogs), [rows, blogs]);
  const theme = React.useMemo(() => deriveTheme(rows), [rows]);

  /**
   * A generation writes roadmap.csv from OUTSIDE this page, so the copy fetched on mount is
   * stale the instant the job lands and the operator would be left reloading the browser to
   * see the thing they just waited twenty minutes for. Re-reading on the running to done edge
   * makes the stats and the Preview appear on their own, because a roadmap now exists.
   *
   * The edge, not the state: a job that was already done when this page mounted needs no
   * re-read, since the read on mount was made after the file was written and is already
   * current. Firing on the state alone would GET the CSV again on every visit forever.
   */
  const genState = gen.job?.state ?? null;
  const previousGenState = React.useRef<typeof genState>(null);
  const { reload } = roadmap;
  React.useEffect(() => {
    const was = previousGenState.current;
    previousGenState.current = genState;
    if (was === "running" && genState === "done") {
      reload();
    }
  }, [genState, reload]);

  const mock = mockReasonOf(geoMock, demoMode);

  // Both reads start on mount and settle together, and the page cannot answer either of its
  // questions until they do: whether there is a roadmap, and whether one is being generated.
  // Rendering the empty state before the second lands would flash a live Generate button over
  // a brand that already has a generation running, which is a click the engine can only 409.
  if (roadmap.loading || gen.checking) {
    return <Skeleton className="h-96 w-full" />;
  }

  // A 404 is not an error here, it is the empty state, and useRoadmap already parks it as one.
  // Anything left is the engine refusing or unreachable, which is its own sentence to render.
  if (roadmap.error) {
    return <EngineDown error={roadmap.error} />;
  }

  // Every roadmap delete is 409'd while a run is live, because the run's topics came from this
  // sheet. The button says so rather than offering a click whose only outcome is a refusal.
  const locked = liveRun !== null;

  // The same sheet, and the same reason: a generation REPLACES roadmap.csv, so the engine
  // refuses to start one under a live run exactly as it refuses a delete. A second generation
  // is refused too, and the running one is already on this page.
  const generating = gen.job !== null && gen.job.state === "running";
  const generateLockedReason = generating
    ? `A generation is already running for ${brandName}, and the engine refuses a second one. It is the card above this.`
    : locked
      ? `A blog run is live for ${brandName}. Its topics came from this sheet, so the engine refuses to write a new one underneath it.`
      : undefined;

  if (!roadmap.data) {
    return (
      <div className="w-full">
        {/* Above the empty state rather than inside it: a generation in flight is the answer to
            "why is there no roadmap", and it outlives the emptiness it explains. */}
        <RoadmapGeneration brandSlug={brandSlug} brandName={brandName} mock={mock} gen={gen} />
        <NoRoadmap
          brandSlug={brandSlug}
          brandName={brandName}
          brandDomain={brandDomain}
          mock={mock}
          generateLocked={generating || locked}
          generateLockedReason={generateLockedReason}
          onUploaded={roadmap.set}
          onStarted={gen.adopt}
          onRefused={gen.recheck}
        />
      </div>
    );
  }

  const withBlog = stats.topics - stats.remaining;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Content roadmap
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            The topic list {brandName}&apos;s blogs are written from, and where it stands.
            Picking topics and writing them happen on Create Blogs.
          </p>
        </div>

        {/* No upload while a roadmap exists: the engine 409s it with "delete it first", so a
            button here could only ever be refused, and offering it would teach the operator
            that the path is upload-then-argue rather than delete-then-upload. */}
        <div className="flex flex-wrap items-center gap-2">
          <RoadmapPreviewDialog brandSlug={brandSlug} brandName={brandName} />
          <DeleteRoadmapDialog
            brandSlug={brandSlug}
            brandName={brandName}
            rowCount={stats.topics}
            generatedCount={withBlog}
            locked={locked}
            onDeleted={roadmap.clear}
          />
        </div>
      </div>

      {/* There is no Generate button on this branch, for the reason the uploader has none: a
          brand with a roadmap gets "delete it first" from the engine, so the button could only
          ever be refused. The card still renders, because the roadmap on this page may be the
          one a generation just wrote and its report is the account of how it was planned. */}
      <RoadmapGeneration brandSlug={brandSlug} brandName={brandName} mock={mock} gen={gen} />

      {locked ? (
        <Card className="mt-6 border-review/25 bg-review-bg">
          <CardContent>
            <p className="flex items-center gap-1.5 text-sm font-medium text-review">
              <CircleDot className="size-3.5 shrink-0" aria-hidden />A run is live for{" "}
              {brandName}
            </p>
            {/* Why, not just what. The live session is writing blogs from these exact topics,
                so deleting the sheet underneath it would pull the brief out of a run that is
                still reading it. */}
            <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              The roadmap cannot be deleted while it runs. Its topics came from this sheet and
              the session is still working from them. Deleting frees up when the run finishes.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {roadmap.data.warnings.length > 0 ? (
        <Card className="mt-6 border-review/25 bg-review-bg">
          <CardContent>
            <p className="text-sm font-medium text-review">
              The engine had {plural(roadmap.data.warnings.length, "a note", "notes")} on this
              sheet
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {roadmap.data.warnings.map((warning) => (
                <li key={warning} className="machine text-xs wrap-break-word text-muted-foreground">
                  {warning}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {stats.topics === 0 ? (
        // The file exists and parsed to nothing, which is not the same as having no roadmap:
        // an upload would still be refused, and the way out is still to delete it first. Tiles
        // reading zero would dress that up as a state of work rather than a broken sheet.
        <Card className="mt-6">
          <CardContent className="py-16 text-center">
            <p className="text-sm font-medium text-foreground">This roadmap has no topics in it</p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
              The sheet uploaded and parsed, and the engine read no rows out of it. Preview it to
              see what arrived, then delete the roadmap and upload one with topics in it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Topics on the roadmap"
              value={stats.topics}
              note={`Everything ${brandName} has planned to write.`}
            />
            {/* The outcome tiles count every blog on disk, not only the ones whose row is
                still on the sheet, so this states the population they are counted against. It
                can legitimately exceed the topic count: blogs outlive the sheets that planned
                them, and a brand keeps every blog it has ever written. */}
            <StatTile
              label="Blogs written"
              value={stats.blogs}
              note={`Every blog ${brandName} has on disk, across every roadmap it has had.`}
            />
            <StatTile
              label="Shipped"
              value={stats.shipped}
              tone="ship"
              note="Scored 95 or above on the first eval with nothing left to ask, which is the only way a blog ships here."
            />
            <StatTile
              label="Waiting on you"
              value={stats.review}
              tone="review"
              note="Written and waiting on a person, not broken. A blog lands here when the evaluator asked something only you can answer, and it waits whatever it scored: a 96 with an open question is held too."
            />
            <StatTile
              label="Failed"
              value={stats.failed}
              tone="fail"
              note="The run ended without a draft that could ship."
            />
            {/* Only when there is one, like Running below: most brands were never stopped, and a
                tile reading zero would put a permanent reminder of a thing that never happened on
                a page whose job is the numbers that mean something.

                NO TONE. It is deliberately the plain tile rather than the fail one: the operator
                pressed Stop, so this number is their own decision reported back, and tinting it
                red would make a brand that did exactly what it was told look damaged. */}
            {stats.stopped > 0 ? (
              <StatTile
                label="Stopped"
                value={stats.stopped}
                note={`${plural(stats.stopped, "This blog was", "These blogs were")} in flight when you stopped ${brandName}. Nothing was deleted, so generating the ${plural(stats.stopped, "topic", "topics")} again picks up whatever ${plural(stats.stopped, "it", "they")} had.`}
              />
            ) : null}
            <StatTile
              label="Remaining to write"
              value={stats.remaining}
              note={`${plural(stats.remaining, "This topic has", "These topics have")} no blog on disk yet.`}
            />
            {/* Only when there is something running. A tile reading zero on an idle engine is
                noise on a page whose whole job is the numbers that mean something. */}
            {stats.running > 0 ? (
              <StatTile
                label="Running"
                value={stats.running}
                note={`${plural(stats.running, "One topic is", "These topics are")} in flight right now.`}
              />
            ) : null}
            {/* Only when there is one. An incomplete row cannot be written at all, so unlike
                every other number here it is a thing to go and fix. */}
            {stats.incomplete.length > 0 ? (
              <StatTile
                label="Incomplete rows"
                value={stats.incomplete.length}
                tone="review"
                note={`${plural(stats.incomplete.length, "This row is", "These rows are")} missing ${stats.missingFields.join(", ")}, so ${plural(stats.incomplete.length, "it cannot", "they cannot")} be written until the sheet is fixed.`}
              />
            ) : null}
          </div>

          <Card className="mt-4">
            <CardContent className="py-8">
              <p className="text-sm font-medium text-foreground">What these blogs are about</p>
              {theme.length > 0 ? (
                <>
                  <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                    The terms that recur across the topics, counted from the sheet. The number is
                    how many topics carry each one.
                  </p>
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {theme.map((term) => (
                      <li
                        key={term.term}
                        className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
                      >
                        {term.term}
                        <span className="machine text-xs text-muted-foreground">
                          {formatCount(term.topics)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  This roadmap has no single recurring theme: no term appears in more than one
                  topic. That is a real answer about the sheet rather than a gap, and a roadmap
                  of unrelated topics is a legitimate thing to have.
                </p>
              )}
            </CardContent>
          </Card>

        </>
      )}
    </div>
  );
}

type Tone = "plain" | "ship" | "review" | "fail";

const TONES: Record<Tone, string> = {
  plain: "text-foreground",
  ship: "text-ship",
  review: "text-review",
  fail: "text-fail",
};

/**
 * One number, big, with the sentence that says what it means.
 *
 * The note is not decoration. "Needs review: 3" and "Failed: 3" look identical at a glance and
 * mean opposite things, and the colour alone cannot carry that difference to someone who reads
 * the number before the palette.
 */
function StatTile({
  label,
  value,
  note,
  tone = "plain",
}: {
  label: string;
  value: number;
  note: string;
  tone?: Tone;
}) {
  return (
    <Card className="[--card-spacing:--spacing(6)]">
      <CardContent className="flex flex-col">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
        <p className={cn("machine mt-4 text-4xl font-semibold", TONES[tone])}>
          {formatCount(value)}
        </p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

/**
 * No roadmap, so getting one is genuinely the only thing this tab can do. No stats either: a
 * grid of tiles reading zero over a sheet that does not exist would describe work that was
 * never planned, which is worse than describing nothing.
 *
 * Two ways to get one, and they are not equals. Upload keeps the accent because it is instant,
 * free, and the operator already has the sheet. Generate is outline: it is a long research
 * session that spends real quota, so it is offered plainly rather than styled as the thing to
 * press by default. It is no longer disabled, and the tooltip claiming it does nothing is gone
 * with it: the dialog behind it is wired to the engine.
 */
function NoRoadmap({
  brandSlug,
  brandName,
  brandDomain,
  mock,
  generateLocked,
  generateLockedReason,
  onUploaded,
  onStarted,
  onRefused,
}: {
  brandSlug: string;
  brandName: string;
  brandDomain: string;
  mock: MockReason | null;
  generateLocked: boolean;
  generateLockedReason?: string;
  onUploaded: React.ComponentProps<typeof RoadmapUploader>["onUploaded"];
  onStarted: React.ComponentProps<typeof GenerateRoadmapDialog>["onStarted"];
  onRefused: () => void;
}) {
  return (
    <Card className="mx-auto mt-4 max-w-xl">
      <CardContent className="py-14 text-center">
        <FileSpreadsheet className="mx-auto size-5 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium text-foreground">
          {brandName} has no content roadmap
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
          The roadmap is the brief. The factory reads columns 1, 2 and 5: the topic, what the
          piece covers, and the target prompts it must be cited for. Every other column is
          passed to the writer as guidance, under its own header.
          Uploading only parses the sheet; nothing generates until you pick rows on Create Blogs.
        </p>

        <div className="mt-6 flex justify-center">
          <RoadmapUploader
            slug={brandSlug}
            label="Upload roadmap"
            variant="default"
            dropzone
            onUploaded={onUploaded}
          />
        </div>

        <div className="mt-5 border-t border-border pt-5">
          <p className="mx-auto max-w-md text-xs leading-relaxed text-muted-foreground">
            No sheet to upload? Claude Code can research {brandName} and write one. It reads
            everything already uploaded for this brand first, then the live site, then the
            demand data.
          </p>
          <div className="mt-3 flex justify-center">
            <GenerateRoadmapDialog
              brandSlug={brandSlug}
              brandName={brandName}
              brandDomain={brandDomain}
              mock={mock}
              locked={generateLocked}
              lockedReason={generateLockedReason}
              onStarted={onStarted}
              onRefused={onRefused}
            />
          </div>
          {/* Said in the layout, not only in a title attribute: a disabled button whose reason
              is hover-only is unreadable to exactly the people most likely to want it. */}
          {generateLocked && generateLockedReason ? (
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-review">
              {generateLockedReason}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

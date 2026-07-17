"use client";

import * as React from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDescribe } from "@/lib/describe-context";
import { useOrgs } from "@/lib/orgs-context";
import { useNow } from "@/components/create/use-now";
import { formatElapsed } from "@/lib/format";
import { FieldError } from "@/components/clients/engine-error";

/**
 * Drafts a description from the brand's live site and hands it back to the caller.
 *
 * What it actually runs: the engine opens ONE short Claude Code session (the SDK spawns the CLI
 * as a subprocess) with Firecrawl as its only tool, no Write, no Edit, no Bash. That session
 * scrapes the homepage and returns a paragraph. Real mode therefore takes tens of seconds, which
 * is why the pending state below has a clock: a button that sits silent for forty seconds reads
 * as broken.
 *
 * It never saves. The engine's describe endpoint does not write either: it reads the site through
 * Firecrawl and returns prose. A draft that saved itself would put unreviewed text about a real
 * brand into the file Agent W loads, so the operator edits and submits.
 *
 * A VIEW OF THE JOB, NOT THE OWNER OF IT. The wait lives in lib/describe-context, above every
 * route, because this component unmounts on Cancel and on Save as well as on navigation. It used
 * to await the POST and read a description out of it, which is a field the engine sends as null
 * at that instant: the draft then landed in the engine uncollected while this pushed null into
 * the textarea. Reading the settled job is what actually collects it.
 */
export function DescribeAction({
  slug,
  disabled,
  disabledReason,
  onDrafted,
}: {
  slug: string | null;
  disabled?: boolean;
  disabledReason?: string;
  onDrafted: (description: string) => void;
}) {
  const { geoMock } = useOrgs();
  const { jobs, start, clear, startError } = useDescribe();

  const job = slug === null ? undefined : jobs.get(slug);
  const error = slug === null ? undefined : startError.get(slug);
  const pending = job?.state === "running";
  const now = useNow(pending);

  /*
    Collects the draft the instant the job settles, wherever the operator started it.

    An effect and not a callback on the click, because the two are genuinely different moments:
    the session outlives this component, so the draft can land while this is unmounted and be
    waiting here on the next visit. Reading it from the job covers both without a second path.

    onDrafted is called through a ref-free dependency list on purpose: the callers pass an inline
    arrow, so listing it would re-run this on every render of the card and re-fill the textarea
    under the operator's cursor after they had edited it. The job id, which is the brand and its
    finish instant, is the thing that says "this is a new draft".
  */
  const collected = React.useRef<string | null>(null);
  // Written in an effect rather than during render, which is the rule this codebase's lint
  // enforces: a ref is not render data, and the collect below reads it after commit anyway.
  const onDraftedRef = React.useRef(onDrafted);
  React.useEffect(() => {
    onDraftedRef.current = onDrafted;
  });

  /**
   * The pages the collected draft was read from, kept HERE rather than read off the job.
   *
   * Collecting drops the job, so rendering this from the job would flash the panel for one frame
   * and then blank it at the exact moment it became true. What it reports is a property of the
   * draft now sitting in the operator's textarea, and that outlives the engine's record of it.
   */
  const [sources, setSources] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (slug === null || job === undefined || job.state !== "done") {
      return;
    }
    if (job.description === null) {
      return;
    }
    // The finish instant, so drafting twice for one brand collects twice while one draft
    // collected once never re-fills the box.
    const stamp = `${job.client}:${job.finished ?? job.started}`;
    if (collected.current === stamp) {
      return;
    }
    collected.current = stamp;
    onDraftedRef.current(job.description);
    setSources(job.sources);
    // Taken. The engine holds a settled job until it is told the operator has it, so clearing is
    // what stops the same finished draft greeting them on every visit forever.
    clear(slug);
  }, [slug, job, clear]);

  /*
    GEO_MOCK short circuits describe to a placeholder that says it was not generated from the
    site. Leaving the button live under it is worse than it sounds: the operator clicks, the box
    instantly fills with an apology, and it reads as a broken button. Then, because the box is a
    normal editable field, that apology gets SAVED as the brand's description. That has already
    happened here: demo's stored description is the placeholder text.

    So the button is disabled and says why. The engine's honest refusal stays as the backstop for
    any caller that reaches the endpoint anyway.
  */
  const mockBlocked = geoMock;
  const reason = mockBlocked
    ? "Drafting is off while the engine runs in safe mode (GEO_MOCK=1), because nothing can read the live site. Restart it with ./run.sh --real to draft from the site."
    : disabledReason;
  const blocked = disabled || mockBlocked || !slug || pending;

  // The clock is the whole point of the pending state in real mode: one Claude Code session plus
  // a scrape runs for tens of seconds, and a silent button that long reads as dead. It measures
  // from the ENGINE's own start instant, not from the click, so a draft still running after a
  // refresh shows how long it has really been going rather than restarting at zero.
  const elapsed = job && now ? formatElapsed(job.started, now) : null;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => slug && void start(slug)}
          disabled={blocked}
          title={mockBlocked ? reason : disabled ? disabledReason : undefined}
        >
          {pending ? (
            <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
          ) : (
            <Sparkles data-icon="inline-start" aria-hidden />
          )}
          {pending ? "Reading the site" : "Draft with Claude"}
        </Button>

        {pending ? (
          // Named plainly: this is a Claude Code session on the operator's own machine spending
          // their own subscription, not a spinner over some abstract cloud call.
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span>Claude Code is scraping the homepage and drafting.</span>
            {elapsed ? <span className="machine text-foreground">{elapsed}</span> : null}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Fills the box below. Nothing is saved until you submit. It keeps drafting if you leave
            this page.
          </p>
        )}
      </div>

      {reason ? <p className="mt-1.5 text-xs text-muted-foreground">{reason}</p> : null}

      {error ? <FieldError error={error} /> : null}

      {/* The session's own failure, which is a different errand from a refused start: the engine
          accepted the draft and the session then died. Its words, not a summary of them. */}
      {job?.state === "failed" && job.error !== null ? (
        <p className="mt-1.5 text-xs text-fail">The draft session failed: {job.error}</p>
      ) : null}

      {sources.length > 0 ? (
        <div className="mt-2 rounded-md border border-border bg-muted/40 px-2.5 py-2">
          <p className="text-xs font-medium text-foreground">Pages it read</p>
          <ul className="mt-1 space-y-0.5">
            {sources.map((source) => (
              <li key={source} className="machine truncate text-xs text-muted-foreground">
                {source}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

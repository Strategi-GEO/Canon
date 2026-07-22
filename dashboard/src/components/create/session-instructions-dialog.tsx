"use client";

import * as React from "react";
import { Play } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The question asked every time Generate is pressed: anything specific to just these blogs?
 *
 * It is the last free moment to shape a run. What is typed here binds ONLY the topics in this
 * run, ranked the same major priority as the brand's standing instructions: above house style
 * and roadmap guidance, never above the brand's canonical facts. It is optional and usually
 * short, so an empty box is a first-class answer and Generate proceeds exactly as before.
 *
 * The brand's standing instructions are shown READ ONLY above the box, so the operator writes
 * this run's note against what is already in force rather than repeating it. They are edited in
 * Settings and nowhere else, which is why they are not editable here.
 *
 * The dialog decides nothing about WHETHER to run: it hands its text back and the caller runs
 * the same submit it always did (fact-base warning included). Escape or Cancel closes it with
 * nothing submitted.
 */
export function SessionInstructionsDialog({
  open,
  onOpenChange,
  brandName,
  brandInstructions,
  selectedCount,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandName: string;
  /** The brand's standing instructions, shown read-only. "" means none are set. */
  brandInstructions: string;
  /** How many blogs this run writes, so the heading names the scope. */
  selectedCount: number;
  /** Proceed with this run's instructions (possibly empty). The caller runs the actual submit. */
  onConfirm: (sessionInstructions: string) => void;
}) {
  // Starts blank. Each open starts from a blank box because the caller remounts this dialog on
  // every Generate press (a key that changes per press), so this run's instructions are never
  // the last run's text riding along: the reset is a fresh mount, not an effect that fights it.
  const [value, setValue] = React.useState("");

  const brand = brandInstructions.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Instructions for this run</DialogTitle>
          <DialogDescription>
            Anything specific to the{" "}
            <span className="machine text-foreground">{selectedCount}</span>{" "}
            {selectedCount === 1 ? "blog" : "blogs"} in this run? The engine follows it as a major
            priority for these blogs only, never above {brandName}&apos;s canonical facts. Optional,
            so you can leave it blank.
          </DialogDescription>
        </DialogHeader>

        {brand ? (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium text-foreground">
              Already in force for {brandName} (from Settings)
            </p>
            <p className="mt-1 max-h-32 overflow-y-auto text-xs whitespace-pre-wrap text-muted-foreground">
              {brand}
            </p>
          </div>
        ) : null}

        <Textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={5}
          placeholder="e.g. Lead every blog with a statistic. Keep them under 900 words for this batch."
          className="min-h-28"
        />

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {/* Same button whether the box is empty or full: an empty run is a legitimate answer,
              so this never disables. It just carries whatever is in the box (trimmed by the
              engine) into the same submit the button always ran. */}
          <Button size="sm" onClick={() => onConfirm(value)}>
            <Play aria-hidden data-icon="inline-start" />
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

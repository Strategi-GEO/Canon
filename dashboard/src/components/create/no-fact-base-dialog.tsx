"use client";

import Link from "next/link";
import { Play, Upload } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * The one question worth asking before a brand's first blog: this run builds the fact base, and
 * you have given it nothing to build from.
 *
 * It is a WARNING and never a block. The operator asked to be told, not stopped, and there are
 * real reasons to proceed: a brand whose site says everything, a demo, a deliberate look at what
 * the site alone yields. So Generate stays enabled and this asks once, at the moment the answer
 * still costs nothing.
 *
 * Why here rather than after: canonical-facts.md is inherited. Every blog this brand ever gets is
 * written and audited against that one file, so a thin one is not a thin blog, it is twenty of
 * them, and by the time anyone reads the first the run has already spent its quota. This is the
 * last moment the choice is free.
 *
 * It never appears for a brand that HAS the file, or for one with resources on disk: an operator
 * who uploaded resources has already answered this, and asking twice teaches them to click past
 * it.
 */
export function NoFactBaseDialog({
  open,
  onOpenChange,
  brandName,
  resourcesHref,
  mock,
  onProceed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandName: string;
  /** This brand's Resources tab. The route owns the URL; this component never builds one. */
  resourcesHref: string;
  /** True when this brand's runs call nothing live, so the cost sentence must not claim spend. */
  mock: boolean;
  /** Submits the run exactly as pressing Generate does on a brand that needs no warning. */
  onProceed: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/*
        No trigger. Generate is the trigger, and only sometimes: a brand with a fact base or with
        resources submits on that same press. Wiring this to a Trigger would open it on every
        press and leave the caller no way to say which presses are questions.
      */}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{brandName} has no fact base yet</AlertDialogTitle>
          <AlertDialogDescription>
            The engine builds <span className="machine">canonical-facts.md</span> for {brandName}{" "}
            before it writes a single blog in this run. {costLine(mock)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Outside the description, and as a list, because this is the part that decides the
            answer. A description is read past; three lines under a heading are read. */}
        <div className="text-sm">
          <p className="font-medium text-foreground">You have uploaded no resources</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              The fact base is built mainly from the resources you upload: the brochures, spec
              sheets and price lists that say what {brandName} says about itself, most of which
              appear nowhere on the public site.
            </li>
            <li>
              With none, the engine has only the live site to go on. The fact base comes out
              thinner, and more of what it finds lands in the unverified section, which blogs are
              forbidden to cite.
            </li>
            <li>
              Every blog for {brandName} inherits that one file, so this asks now rather than
              after twenty blogs have been written from it.
            </li>
          </ul>
        </div>

        <AlertDialogFooter>
          {/* The way out that fixes the problem, so it doubles as the cancel: it closes this and
              goes to the Resources tab for THIS brand. Escape closes it too, and lands the
              operator back on their selection with nothing submitted. */}
          <AlertDialogCancel size="sm" asChild>
            <Link href={resourcesHref}>
              <Upload data-icon="inline-start" aria-hidden />
              Upload resources
            </Link>
          </AlertDialogCancel>
          {/* Not destructive: proceeding is a legitimate answer, and dressing it in red would
              tell an operator that the button they came here to press is a mistake. It submits
              the run exactly as it would have without this dialog. */}
          <AlertDialogAction size="sm" onClick={onProceed}>
            <Play data-icon="inline-start" aria-hidden />
            Proceed anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * What building the fact base actually costs, which is the one thing this dialog owes the
 * operator before they answer it.
 *
 * Mock is stated as plainly as real, and for the same reason the roadmap dialog does it: an
 * operator who believes a demo run spends their personal quota will not press the button that
 * demo mode exists for, and one who believes a real run is free finds out afterwards.
 */
function costLine(mock: boolean): string {
  if (mock) {
    return "This brand's runs are mock, so it is built without a live call and nothing is spent.";
  }
  return "That is a long step on its own, and it spends your Claude subscription quota before the first blog starts.";
}

"use client";

import * as React from "react";
import { FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { cn } from "@/lib/utils";

/**
 * The ONE way instructions and notes are viewed across the app: a dialog that renders them as
 * markdown, scrolls when they are long, and shows horizontal tabs when there is more than one
 * source (a blog run's brand + session notes) or a single pane when there is one (a roadmap's
 * notes). Blog and roadmap surfaces both drive this, so they can never render instructions two
 * different ways.
 *
 * Instructions are authored in markdown, so they render through the shared MarkdownView
 * (document variant, which escapes every HTML metacharacter before transforming). Empty sources
 * are dropped, not shown as empty tabs, which is also what collapses a two-source blog view to a
 * single pane for a re-attached run whose session note this browser never saw.
 */
export type InstructionTab = {
  /** Stable tab id. */
  value: string;
  /** The tab label, e.g. "Brand instructions" or "This run". Ignored when only one tab remains. */
  label: string;
  /** The markdown to render. Dropped when blank. */
  source: string;
};

function usableTabs(tabs: InstructionTab[]): InstructionTab[] {
  return tabs.filter((t) => t.source.trim() !== "");
}

export function InstructionsViewer({
  open,
  onOpenChange,
  title,
  tabs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  tabs: InstructionTab[];
}) {
  const shown = usableTabs(tabs);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Widened past the default narrow content and capped in height, so a long note scrolls
          inside the dialog rather than running off the viewport. p-0 because the tabs and the
          scroll region own their own padding. */}
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4 pr-14">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            The instructions this work is written under, in markdown.
          </DialogDescription>
        </DialogHeader>

        {shown.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No instructions to show.</p>
        ) : shown.length === 1 ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
            <MarkdownView source={shown[0].source} variant="document" />
          </div>
        ) : (
          <Tabs defaultValue={shown[0].value} className="min-h-0 flex-1 gap-0">
            <div className="border-b px-4 py-2">
              <TabsList variant="line">
                {shown.map((t) => (
                  <TabsTrigger key={t.value} value={t.value} className="text-xs">
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {shown.map((t) => (
              <TabsContent
                key={t.value}
                value={t.value}
                className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
              >
                <MarkdownView source={t.source} variant="document" />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A "View instructions" button that owns its own open state and renders the viewer. This is the
 * one call site every surface uses, so the trigger looks and behaves the same everywhere.
 *
 * It renders NOTHING when there is nothing to show (every source blank), which is what gates the
 * button on a run with no notes, or a roadmap dialog before anything is typed. The caller does
 * not repeat that check.
 */
export function ViewInstructionsButton({
  title,
  tabs,
  label = "View instructions",
  variant = "outline",
  size = "sm",
  className,
}: {
  title: string;
  tabs: InstructionTab[];
  label?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  if (usableTabs(tabs).length === 0) {
    return null;
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={cn(className)}
        onClick={() => setOpen(true)}
      >
        <FileText aria-hidden data-icon="inline-start" />
        {label}
      </Button>
      <InstructionsViewer open={open} onOpenChange={setOpen} title={title} tabs={tabs} />
    </>
  );
}

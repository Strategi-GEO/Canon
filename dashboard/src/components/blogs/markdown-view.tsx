"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { renderMarkdown } from "@/components/blogs/markdown";

/**
 * Typography for a rendered artifact.
 *
 * The preview is the one screen in this app that is a DOCUMENT rather than a control panel,
 * and it is the payoff for a twenty minute run, so it is set like one: Georgia headings, a
 * measure that stops around seventy characters, and rhythm that comes from the heading levels
 * rather than from rules and boxes.
 *
 * Two variants, because two jobs share this renderer. `article` is blog.md, which a human
 * reads end to end. `document` is eval.md and dossier.md, which a human scans for a number or
 * a claim: denser, and unconstrained in width because their tables are wide.
 */

/** Shared by both variants: the parts that are correctness rather than taste. */
const BASE = [
  "text-foreground",
  "[&_.md-h]:font-serif [&_.md-h]:font-normal [&_.md-h]:text-foreground [&_.md-h]:text-pretty [&_.md-h]:tracking-tight",
  "[&_.md-h1]:mt-0",
  "[&_.md-list]:pl-5 [&_.md-ul]:list-disc [&_.md-ol]:list-decimal",
  "[&_.md-list_li]:pl-1 [&_.md-list_li]:marker:text-muted-foreground",
  // Links are the point of a GEO piece: each one goes to the real source behind a statistic.
  // The UNDERLINE marks them, not the colour, so an article carrying sixteen citations does
  // not become sixteen accent-coloured interruptions. The accent arrives on hover and focus,
  // where it means "this is the one you are about to open".
  "[&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:decoration-primary/40 [&_a]:underline-offset-[3px] [&_a]:wrap-anywhere",
  "[&_a:hover]:text-primary [&_a:hover]:decoration-primary",
  "[&_a:focus-visible]:rounded-xs [&_a:focus-visible]:text-primary [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring",
  "[&_.md-code]:machine [&_.md-code]:rounded [&_.md-code]:bg-muted [&_.md-code]:px-1 [&_.md-code]:py-0.5",
  "[&_.md-pre]:machine [&_.md-pre]:overflow-x-auto [&_.md-pre]:rounded-md [&_.md-pre]:border [&_.md-pre]:bg-muted [&_.md-pre]:p-3 [&_.md-pre]:text-xs",
  // A wide comparison table scrolls inside its own box rather than stretching the drawer.
  "[&_.md-table-wrap]:overflow-x-auto [&_.md-table-wrap]:rounded-md [&_.md-table-wrap]:border",
  "[&_.md-table]:w-full [&_.md-table]:border-collapse",
  "[&_.md-table_th]:machine [&_.md-table_th]:border-b [&_.md-table_th]:bg-muted [&_.md-table_th]:px-3 [&_.md-table_th]:py-2 [&_.md-table_th]:text-left [&_.md-table_th]:font-medium",
  "[&_.md-table_td]:border-b [&_.md-table_td]:px-3 [&_.md-table_td]:py-2 [&_.md-table_td]:align-top",
  "[&_.md-table_tr:last-child_td]:border-b-0",
  "[&_.md-hr]:border-border",
];

const ARTICLE = [
  // Measure: about 68 to 72 characters at this size, which is where a line stops making the
  // eye hunt for the start of the next one.
  "mx-auto max-w-[68ch] text-[0.9375rem] leading-[1.75]",
  "[&_.md-h1]:mb-4 [&_.md-h1]:text-[1.75rem] [&_.md-h1]:leading-tight",
  // A heading owns the block beneath it, so the space above it is large and below it small.
  // Equal space on both sides is what makes a long article read as undifferentiated.
  "[&_.md-h2]:mt-10 [&_.md-h2]:mb-3 [&_.md-h2]:border-b [&_.md-h2]:pb-1.5 [&_.md-h2]:text-[1.375rem] [&_.md-h2]:leading-snug",
  "[&_.md-h3]:mt-7 [&_.md-h3]:mb-2 [&_.md-h3]:text-[1.125rem]",
  "[&_.md-h4]:mt-6 [&_.md-h4]:mb-1.5 [&_.md-h4]:text-base",
  "[&_.md-h5]:mt-5 [&_.md-h5]:mb-1 [&_.md-h5]:text-sm",
  "[&_.md-h6]:mt-5 [&_.md-h6]:mb-1 [&_.md-h6]:text-xs",
  "[&_.md-p]:my-4",
  "[&_.md-list]:my-4 [&_.md-list]:space-y-2",
  // A blockquote in a GEO piece is usually the standalone citeable statement, the line most
  // worth lifting, so it earns the accent rule and stays in Georgia.
  "[&_.md-quote]:my-6 [&_.md-quote]:border-l-2 [&_.md-quote]:border-primary/50 [&_.md-quote]:pl-4 [&_.md-quote]:font-serif [&_.md-quote]:text-base [&_.md-quote]:text-muted-foreground",
  "[&_.md-hr]:my-10",
  "[&_.md-code]:text-[0.8125em]",
  "[&_.md-pre]:my-5",
  "[&_.md-table-wrap]:my-6",
  "[&_.md-table]:text-[0.8125rem]",
];

const DOCUMENT = [
  "text-sm leading-relaxed",
  "[&_.md-h1]:mb-3 [&_.md-h1]:text-2xl",
  "[&_.md-h2]:mt-7 [&_.md-h2]:mb-2 [&_.md-h2]:text-xl",
  "[&_.md-h3]:mt-6 [&_.md-h3]:mb-2 [&_.md-h3]:text-base [&_.md-h3]:font-medium",
  "[&_.md-h4]:mt-5 [&_.md-h4]:mb-1.5 [&_.md-h4]:text-sm [&_.md-h4]:font-medium",
  "[&_.md-h5]:mt-4 [&_.md-h5]:mb-1 [&_.md-h5]:text-sm",
  "[&_.md-h6]:mt-4 [&_.md-h6]:mb-1 [&_.md-h6]:text-xs",
  "[&_.md-p]:my-3",
  "[&_.md-list]:my-3 [&_.md-list]:space-y-1.5",
  "[&_.md-quote]:my-4 [&_.md-quote]:border-l-2 [&_.md-quote]:border-border [&_.md-quote]:pl-3 [&_.md-quote]:text-muted-foreground",
  "[&_.md-hr]:my-6",
  "[&_.md-code]:text-[0.8125rem]",
  "[&_.md-pre]:my-4",
  "[&_.md-table-wrap]:my-4",
  "[&_.md-table]:text-xs",
];

export function MarkdownView({
  source,
  variant = "document",
  className,
}: {
  source: string;
  variant?: "article" | "document";
  className?: string;
}) {
  const html = React.useMemo(() => renderMarkdown(source), [source]);

  // dangerouslySetInnerHTML is safe here and only here: renderMarkdown escaped every HTML
  // metacharacter in the file BEFORE applying any transform, so the only tags in this
  // string are ones the renderer itself emitted. Never pass raw file text to this prop.
  return (
    <div
      className={cn(BASE, variant === "article" ? ARTICLE : DOCUMENT, className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

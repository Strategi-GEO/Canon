"use client";

import * as React from "react";
import { PenLine } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { cn } from "@/lib/utils";

/**
 * Paste markdown on the left, see it rendered on the right. The shared body of both blog-writing
 * surfaces: the off-roadmap /create/new page, and the upload-an-article dialog on a roadmap row.
 * It owns only the two panes; the caller owns the title, the submit and what the article is FOR,
 * because those differ (create derives a title from the H1; upload already knows the topic).
 */
export function MarkdownSplitEditor({
  value,
  onChange,
  disabled,
  placeholder,
  className,
  paneClassName,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Height of each pane. The caller sets it because a dialog and a full page want different
   *  heights (a tall min-h on the page, a fixed viewport-bounded height inside a dialog). */
  paneClassName?: string;
}) {
  const id = React.useId();
  return (
    <div className={cn("grid gap-4 lg:grid-cols-2", className)}>
      <div className="flex min-w-0 flex-col">
        <label
          htmlFor={id}
          className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
        >
          <PenLine className="size-3.5" aria-hidden />
          Markdown
        </label>
        <Textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          className={cn("machine resize-y text-sm leading-relaxed", paneClassName)}
        />
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="mb-1.5 text-xs font-medium text-muted-foreground">Preview</span>
        <Card className={cn("overflow-auto", paneClassName)}>
          <CardContent className="py-6">
            {value.trim() !== "" ? (
              <MarkdownView source={value} variant="article" />
            ) : (
              <p className="text-sm text-muted-foreground">
                Your article renders here as you type.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A read-only block of client prose.
 *
 * This file used to also export an EditableText that PATCHed the field back and hosted a "Draft
 * with Claude" button. Both are gone: the one field it edited, the brand description, is now
 * generated from the brand website by the engine and is never typed or changed by hand (see
 * server/describe.py). So every surface that shows client prose shows it the same way, read only,
 * and there is no second screen that could disagree with this one about what it says.
 */

/** The card shell shared by every read-only prose block, so they cannot drift into looking like
 *  two different kinds of thing. */
function TextCard({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-foreground">{title}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{help}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** The prose as the engine holds it, or the empty state. Never a control. */
function Prose({
  value,
  emptyText,
  mono,
}: {
  value: string;
  emptyText: string;
  mono: boolean;
}) {
  if (value.trim() === "") {
    return <p className="text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <p className={cn("text-sm whitespace-pre-wrap text-foreground", mono && "machine text-xs")}>
      {value}
    </p>
  );
}

/**
 * A block of client prose with NO way to change it.
 *
 * Showing one field from two screens is two screens that can disagree, and the operator has no
 * way to tell which one they are looking at once they do. This field is generated, not authored,
 * so there is nowhere it is editable and every screen simply shows what the engine holds.
 */
export function ReadOnlyText({
  title,
  help,
  value,
  emptyText,
  mono = false,
}: {
  title: string;
  help: string;
  value: string;
  emptyText: string;
  mono?: boolean;
}) {
  return (
    <TextCard title={title} help={help}>
      <Prose value={value} emptyText={emptyText} mono={mono} />
    </TextCard>
  );
}

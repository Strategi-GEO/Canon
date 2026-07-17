"use client";

import * as React from "react";
import { Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Client } from "@/types";
import { FieldError } from "@/components/clients/engine-error";
import { DescribeAction } from "@/components/clients/describe-action";
import { updateClient, type UpdateClientWire } from "@/components/clients/wire";

/**
 * The card both states share. One shell, so a read only block of client prose and an editable
 * one cannot drift into looking like two different kinds of thing.
 */
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
 * The same block of client prose with NO way to change it.
 *
 * Editing one field from two screens is two screens that can disagree, and the operator has no
 * way to tell which one they are looking at once they do. Settings is where this brand is
 * configured, so Settings is the only place these fields are edited. Everywhere else shows what
 * the engine currently holds, which is what a view of a brand is for.
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

/**
 * An inline edited block of client prose, saved with a PATCH.
 *
 * PATCH sends only the field being edited: the engine reads an absent key as "do not
 * write", so a form that posted every field would let a stale description overwrite one
 * that changed in another tab.
 */
export function EditableText({
  brandSlug,
  title,
  help,
  value,
  field,
  placeholder,
  emptyText,
  mono = false,
  rows = 6,
  describable = false,
  onSaved,
}: {
  brandSlug: string;
  title: string;
  help: string;
  value: string;
  field: "description" | "never_claim";
  placeholder?: string;
  emptyText: string;
  mono?: boolean;
  rows?: number;
  describable?: boolean;
  onSaved: (client: Client) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  function start() {
    setDraft(value);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setDraft(value);
    setError(null);
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: UpdateClientWire =
        field === "description" ? { description: draft } : { never_claim: draft };
      const updated = await updateClient(brandSlug, body);
      onSaved(updated);
      toast.success(`${title} saved`);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <TextCard title={title} help={help}>
      {describable && editing ? (
        <div className="mb-3">
          <DescribeAction slug={brandSlug} onDrafted={(text) => setDraft(text)} />
        </div>
      ) : null}

      {editing ? (
        <>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={rows}
            placeholder={placeholder}
            aria-label={title}
            className={cn(mono && "machine text-xs")}
          />
          {error ? <FieldError error={error} /> : null}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : null}
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <Prose value={value} emptyText={emptyText} mono={mono} />
          <Button size="sm" variant="outline" className="mt-3" onClick={start}>
            <Pencil data-icon="inline-start" aria-hidden />
            Edit
          </Button>
        </>
      )}
    </TextCard>
  );
}

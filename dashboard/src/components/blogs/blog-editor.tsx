"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import { formatCount } from "@/lib/format";

/**
 * The raw markdown, editable. The editable-text pattern scaled up to an article: Save
 * writes through the engine (disk, then the record, so a new blog_versions row is the
 * undo trail), Cancel discards, errors render inline and keep the draft intact.
 *
 * The editor holds RAW markdown on purpose. The rendered view is where selections and
 * Claude comments live; this mode exists for the operator who wants to touch the bytes
 * themselves, and raw bytes are the only honest thing to save.
 */
export function BlogEditor({
  brandSlug,
  topicSlug,
  initial,
  value,
  onChange,
  onSaved,
  onCancel,
}: {
  brandSlug: string;
  topicSlug: string;
  /** The article as the engine last served it, for the nothing-changed Save guard. */
  initial: string;
  /**
   * CONTROLLED, and the owner is the stage, not this component: the tabs unmount their
   * inactive content, so a draft held here would be destroyed by a glance at the Eval
   * tab mid-edit.
   */
  value: string;
  onChange: (text: string) => void;
  /** Hands the saved text up so the view re-renders it without a second fetch. */
  onSaved: (text: string) => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveBlogContent(brandSlug, topicSlug, value);
      toast.success("Blog saved", {
        description: `${formatCount(result.word_count)} words committed to the record.`,
      });
      onSaved(value);
    } catch (cause) {
      // Stay in edit mode with the draft intact: the error names what to fix, and
      // discarding the operator's typing over it would be the worse failure.
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Edit the blog markdown"
        spellCheck={false}
        className="machine min-h-[65svh] text-[13px] leading-relaxed"
        disabled={saving}
      />
      {error ? <FieldError error={error} className="mt-2" /> : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving || value === initial}>
          {saving ? (
            <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
          ) : null}
          Save
        </Button>
      </div>
    </div>
  );
}

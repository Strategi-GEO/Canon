"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, FileUp, Loader2, PenLine } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError } from "@/components/clients/engine-error";
import { BrandRoute } from "@/components/shell/brand-route";
import { MarkdownSplitEditor } from "@/components/blogs/markdown-split-editor";
import { HOSTED_READONLY } from "@/lib/hosted";
import { brandHref } from "@/lib/orgs-context";
import type { UploadBlogResult } from "@/types";

/** The engine's markdown ceiling, mirrored so an obvious mistake never costs a round trip. */
const MAX_BYTES = 1_000_000;

/**
 * Upload a finished article against a roadmap topic. The upload twin of /create/new: the same
 * paste-and-preview editor, except the topic, slug and prompts are the roadmap row's and the
 * endpoint reads them server-side, so this collects only the article. The upload icon on a
 * roadmap row links here with ?title= and ?replace= so the page names the topic without a fetch.
 *
 * Engine-only, like every upload path: the hosted build has no upload route.
 */
export default function UploadBlogPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <div className="mx-auto w-full max-w-6xl">
          <Button size="sm" variant="ghost" className="-ml-2 mb-3" asChild>
            <Link href={brandHref(org.slug, brand.slug, "/create")}>
              <ArrowLeft data-icon="inline-start" aria-hidden />
              Create blogs
            </Link>
          </Button>
          {HOSTED_READONLY ? (
            <HostedReadOnly />
          ) : (
            // useSearchParams needs a Suspense boundary, the same as the create tab's own.
            <React.Suspense fallback={null}>
              <UploadBlogEditor orgSlug={org.slug} brandSlug={brand.slug} />
            </React.Suspense>
          )}
        </div>
      )}
    </BrandRoute>
  );
}

function UploadBlogEditor({
  orgSlug,
  brandSlug,
}: {
  orgSlug: string;
  brandSlug: string;
}) {
  const router = useRouter();
  const topicSlug = useParams<{ topic: string }>().topic;
  const query = useSearchParams();
  // The row already knew these and passed them, so the page names the topic without a fetch. Title
  // falls back to the slug on a hand-typed URL; replace is confirmed by the endpoint regardless.
  const title = query.get("title") || topicSlug;
  const replacing = query.get("replace") === "1";

  const inputRef = React.useRef<HTMLInputElement>(null);
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  // Set true when a first upload is refused because the topic already has a blog, so a hand-typed
  // URL that missed ?replace=1 still has a way through instead of a dead-end 409.
  const [forceReplace, setForceReplace] = React.useState(false);

  async function loadFile(picked: File | undefined) {
    if (!picked) {
      return;
    }
    setError(null);
    if (!/\.(md|markdown|txt)$/i.test(picked.name)) {
      setError(new ApiError(0, `${picked.name} is not a markdown file. Load a .md file.`, null));
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError(new ApiError(0, `${picked.name} is too large to be an article.`, null));
      return;
    }
    // The file fills the editor, so the operator reads and tweaks it before upload.
    setBody(await picked.text());
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  const ready = body.trim() !== "";

  async function submit() {
    if (!ready) {
      return;
    }
    const replace = replacing || forceReplace;
    setBusy(true);
    setError(null);
    try {
      const uploaded: UploadBlogResult = await api.uploadBlog(brandSlug, topicSlug, body, replace);
      const gateNote =
        uploaded.gates.ran && !uploaded.gates.passed
          ? ` ${uploaded.gates.failures.length} mechanical gate${uploaded.gates.failures.length === 1 ? "" : "s"} fail; edit on its page to clear them.`
          : "";
      toast.success(uploaded.replaced ? "Article replaced" : "Article uploaded", {
        description: `"${title}" is in admin review with ${uploaded.word_count} words.${gateNote}`,
      });
      // Straight to the blog it created, on the Blogs tab, in internal review.
      router.push(brandHref(orgSlug, brandSlug, `/blogs/${uploaded.topic_slug}`));
    } catch (cause) {
      setBusy(false);
      const apiError = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      setError(apiError);
      // A 409 on a first (non-replace) upload means the topic already has a blog: offer the replace.
      if (apiError.status === 409 && !replace) {
        setForceReplace(true);
      }
    }
  }

  const willReplace = replacing || forceReplace;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {willReplace ? "Replace the article for" : "Upload an article for"} &ldquo;{title}&rdquo;
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {willReplace
              ? "This topic already has a blog. Uploading replaces it with a new version; the old one stays in the record. It goes straight to admin review, with no score or dossier."
              : "Paste the finished article as markdown, or load a file. It goes straight to admin review, like a blog the factory wrote and shipped, with no score or dossier."}
          </p>
        </div>
        <Button onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <FileUp data-icon="inline-start" aria-hidden />
          )}
          {willReplace ? "Replace article" : "Upload article"}
        </Button>
      </div>

      <MarkdownSplitEditor
        value={body}
        onChange={setBody}
        disabled={busy}
        placeholder={`Paste the finished article for "${title}" here, in markdown.`}
        paneClassName="min-h-[64vh]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          className="sr-only"
          onChange={(event) => void loadFile(event.target.files?.[0])}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <FileUp data-icon="inline-start" aria-hidden />
          Load a .md file
        </Button>
        <span className="text-xs text-muted-foreground">A markdown file fills the editor.</span>
      </div>

      {error ? <FieldError error={error} className="mt-3" /> : null}
    </div>
  );
}

/** What the hosted, engine-less deployment shows where the upload editor would be. */
function HostedReadOnly() {
  return (
    <Card className="mx-auto mt-8 max-w-xl">
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <PenLine className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">
          Blogs are uploaded from the operator dashboard
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
          This dashboard is the read-only view of the factory&apos;s record. Uploading an article
          writes to the engine, which this deployment does not have. Everything already written is
          here.
        </p>
      </CardContent>
    </Card>
  );
}

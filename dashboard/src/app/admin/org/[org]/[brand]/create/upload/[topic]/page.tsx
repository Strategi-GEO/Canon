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
  // A .docx cannot be shown in the markdown editor (it is binary, converted server-side), so a
  // chosen one is staged and posted on its own path, which is what carries its Word comments in.
  const [docxFile, setDocxFile] = React.useState<File | null>(null);
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
    if (!/\.(md|markdown|txt|docx)$/i.test(picked.name)) {
      setError(
        new ApiError(0, `${picked.name} is not a markdown or Word file. Load a .md or .docx.`, null),
      );
      return;
    }
    // A .docx is zipped, so it runs larger than the 1 MB the extracted markdown is held to; the
    // engine enforces the real ceiling after unzipping. Markdown keeps the tight 1 MB bar.
    const isDocx = /\.docx$/i.test(picked.name);
    if (picked.size > (isDocx ? MAX_BYTES * 8 : MAX_BYTES)) {
      setError(new ApiError(0, `${picked.name} is too large to be an article.`, null));
      return;
    }
    if (isDocx) {
      setDocxFile(picked);
    } else {
      // A markdown file just fills the editor, so the operator reads and tweaks it before upload.
      setDocxFile(null);
      setBody(await picked.text());
    }
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  const ready = docxFile !== null || body.trim() !== "";

  async function submit() {
    if (!ready) {
      return;
    }
    const replace = replacing || forceReplace;
    setBusy(true);
    setError(null);
    try {
      const uploaded: UploadBlogResult = docxFile
        ? await api.uploadBlogDocx(brandSlug, topicSlug, docxFile, replace)
        : await api.uploadBlog(brandSlug, topicSlug, body, replace);
      const comments =
        typeof uploaded.comments_added === "number" && uploaded.comments_added > 0
          ? `, ${uploaded.comments_added} comment${uploaded.comments_added === 1 ? "" : "s"} imported`
          : "";
      const gateNote =
        uploaded.gates.ran && !uploaded.gates.passed
          ? ` ${uploaded.gates.failures.length} mechanical gate${uploaded.gates.failures.length === 1 ? "" : "s"} fail; edit on its page to clear them.`
          : "";
      toast.success(uploaded.replaced ? "Article replaced" : "Article uploaded", {
        description: `"${title}" is in admin review with ${uploaded.word_count} words${comments}.${gateNote}`,
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

      {docxFile ? (
        // A staged Word file cannot render in the editor, so it stands in for it until sent.
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate font-medium text-foreground">{docxFile.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              Word comments import as review notes
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setDocxFile(null)}
          >
            Use the editor
          </Button>
        </div>
      ) : (
        <MarkdownSplitEditor
          value={body}
          onChange={setBody}
          disabled={busy}
          placeholder={`Paste the finished article for "${title}" here, in markdown.`}
          paneClassName="min-h-[64vh]"
        />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
          Load a .md or .docx file
        </Button>
        <span className="text-xs text-muted-foreground">
          A markdown file fills the editor; a Word .docx imports its comments too.
        </span>
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

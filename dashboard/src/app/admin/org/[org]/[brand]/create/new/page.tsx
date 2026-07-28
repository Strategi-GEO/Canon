"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, FilePlus2, Loader2, PenLine } from "lucide-react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrandRoute } from "@/components/shell/brand-route";
import { MarkdownSplitEditor } from "@/components/blogs/markdown-split-editor";
import { HOSTED_READONLY } from "@/lib/hosted";
import { brandHref } from "@/lib/orgs-context";

/**
 * Write a blog the roadmap never planned.
 *
 * The roadmap picker on /create only offers rows the sheet plans; this is the door for the blog
 * an operator decided to write that no row covers, so they never have to edit the roadmap to add
 * one. It posts the pasted markdown to the off-roadmap create endpoint (api.createBlog), which
 * runs it through the SAME upload path a roadmap upload does: the blog lands in internal review,
 * scoreless and stamped with the operator, and is treated like every other blog from there.
 *
 * Engine-only, exactly like the upload flow it shares: the hosted build has no create endpoint,
 * so it renders the honest note instead of a form that could only be refused.
 */
export default function NewBlogPage() {
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
            <NewBlogEditor
              orgSlug={org.slug}
              brandSlug={brand.slug}
              brandName={brand.name}
            />
          )}
        </div>
      )}
    </BrandRoute>
  );
}

const PLACEHOLDER = `# Your blog title

Paste or write the whole article in markdown. The first "# " heading is the blog's title.

## A section heading

Body text, **bold**, links, tables, and lists all render in the preview on the right.`;

function NewBlogEditor({
  orgSlug,
  brandSlug,
  brandName,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
}) {
  const router = useRouter();
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // The first "# " line is the title, matched exactly as the engine derives it on create, so what
  // the operator sees here is the label the blog will carry. Empty until they add one.
  const title = React.useMemo(() => {
    const line = body.split("\n").find((l) => l.startsWith("# "));
    return line ? line.slice(2).trim() : "";
  }, [body]);
  const canCreate = title !== "" && !saving;

  async function create() {
    if (!canCreate) return;
    setSaving(true);
    try {
      const result = await api.createBlog(brandSlug, body);
      // Navigate straight to the blog it created: it is in internal review now, on the blogs tab.
      // saving stays true through the push so the button cannot fire twice while the route loads.
      toast.success("Blog created", {
        description: `"${title}" is in internal review.`,
      });
      router.push(brandHref(orgSlug, brandSlug, `/blogs/${result.topic_slug}`));
    } catch (cause) {
      setSaving(false);
      toast.error("Could not create this blog", {
        description: cause instanceof ApiError ? cause.message : String(cause),
      });
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Write a new blog for {brandName}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Paste a finished article in markdown. Its first{" "}
            <span className="machine rounded bg-muted px-1 py-0.5 text-xs">#</span> heading
            becomes the title. On create it goes to internal review, like every other blog, no
            roadmap row needed.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button onClick={() => void create()} disabled={!canCreate}>
            {saving ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <FilePlus2 data-icon="inline-start" aria-hidden />
            )}
            Create new blog
          </Button>
          {body.trim() !== "" && title === "" ? (
            <span className="text-xs text-muted-foreground">
              Add a <span className="machine">#</span> heading to name the blog.
            </span>
          ) : null}
        </div>
      </div>

      <MarkdownSplitEditor
        value={body}
        onChange={setBody}
        disabled={saving}
        placeholder={PLACEHOLDER}
        paneClassName="min-h-[70vh]"
      />
    </div>
  );
}

/** What the hosted, engine-less deployment shows where the create editor would be. */
function HostedReadOnly() {
  return (
    <Card className="mx-auto mt-8 max-w-xl">
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <PenLine className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">
          Blogs are created from the operator dashboard
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
          This dashboard is the read-only view of the factory&apos;s record. Creating a blog writes
          to the engine, which this deployment does not have. Everything already written is here.
        </p>
      </CardContent>
    </Card>
  );
}

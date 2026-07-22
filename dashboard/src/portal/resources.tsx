"use client";

import * as React from "react";
import { ResourcesShell, type ResourceOps } from "@/components/clients/resources-shell";
import { ApiError, api, detailText, putResourceBytes } from "@/portal/api";
import type { PortalResource } from "@/portal/types";

/**
 * The client's own fact base: the documents they hand us, which we read before we write
 * anything for the brand. The SURFACE is the shared ResourcesShell, the exact component the
 * admin console renders, so the two lists can never drift apart visually; what differs here is
 * the wire and the words.
 *
 * THE WIRE: bytes go browser -> Storage directly, because Vercel caps a serverless body at
 * 4.5 MB and the resource limit is 25 MiB. Each upload is three trips whose ORDER is
 * load-bearing: hash, PUT the bytes on a signed URL, then write the index row. An upload that
 * dies halfway leaves an object nobody can see and costs nothing; retrying computes the same
 * content address and lands on it again. Writing the index first would list a file the brand
 * cannot open, and its name would then refuse the very retry that would have fixed it.
 *
 * NOTHING HERE IS EVER OVERWRITTEN. A filename already in the list is refused before a byte
 * moves and again by the record's unique constraint; replacing a document is delete then
 * upload, two acts the client can see themselves perform.
 */

/**
 * The object's address, computed in the browser because the browser is the only place the
 * bytes ever are. crypto.subtle exists only in a secure context, which every deployment of
 * this portal is (https, or localhost in development), so there is no fallback path here.
 */
async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * What went wrong, said to the person who chose the file.
 *
 * The 409 arm is the duplicate rule surfacing, and it forwards the record's own sentence
 * because that sentence names the file. A 403 or a 404 on a WRITE is the role check, not a
 * missing brand: the client reached this page from their own brand list, so saying "not
 * found" would send someone hunting for a broken link.
 */
function uploadFailureMessage(error: ApiError, fileName: string): string {
  if (error.isOffline) {
    return `We could not reach the portal, so ${fileName} was not uploaded. Check your connection and try again.`;
  }
  if (error.status === 409) {
    return `${detailText(error)} Nothing was overwritten, and the file you already have is untouched.`;
  }
  if (error.status === 403 || error.status === 404) {
    return "This account cannot change the files here. Whoever manages your account can change that.";
  }
  if (error.status === 413) {
    return `${fileName} is larger than the 25 MB limit for a single file.`;
  }
  return detailText(error);
}

/** A refusal decided before any request was made (a duplicate name), in the client's words. */
class RefusedUpload extends Error {}

/** What the list currently holds, stamped with the brand it was loaded for. */
type Loaded = { brand: string; resources: PortalResource[] };

export function ResourcesView({ brand }: { brand: string }) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [failure, setFailure] = React.useState<{ brand: string; error: ApiError } | null>(null);

  // Both stamps carry the brand they describe, so switching brands shows a loader rather than
  // the previous brand's files.
  const resources = loaded?.brand === brand ? loaded.resources : null;
  const loadError = failure?.brand === brand ? failure.error : null;

  const applyFailed = React.useCallback((forBrand: string, cause: unknown) => {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return;
    }
    setFailure({
      brand: forBrand,
      error: cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
    });
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    api.resources(brand, controller.signal).then(
      (data) => setLoaded({ brand, resources: data.resources }),
      (cause: unknown) => applyFailed(brand, cause),
    );
    return () => controller.abort();
  }, [brand, applyFailed]);

  /**
   * Re-read after an upload or a delete: the server stays the one authority on the order, so
   * the list is refetched rather than patched in place.
   */
  const reload = React.useCallback(async () => {
    try {
      setLoaded({ brand, resources: (await api.resources(brand)).resources });
      setFailure(null);
    } catch (cause) {
      applyFailed(brand, cause);
    }
  }, [brand, applyFailed]);

  /**
   * The original file, byte for byte. The ticket is a plain URL carrying an attachment
   * disposition, so the browser saves it straight from our file store and the bytes never
   * touch this tab's memory.
   */
  const download = React.useCallback(
    async (resource: PortalResource) => {
      const link = await api.resourceLink(brand, resource.name, { download: true });
      const anchor = document.createElement("a");
      anchor.href = link.url;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
    [brand],
  );

  const names = React.useMemo(
    () => new Set((resources ?? []).map((resource) => resource.name)),
    [resources],
  );

  const ops = React.useMemo<ResourceOps<PortalResource>>(
    () => ({
      upload: async (file) => {
        // The record refuses duplicates too, and refuses them authoritatively. Checking here
        // as well turns a 25 MB round trip into an instant answer.
        if (names.has(file.name)) {
          throw new RefusedUpload(
            `${file.name} is already in your files. We never overwrite one, so remove the copy you have if you want to replace it.`,
          );
        }
        const sha256 = await sha256Hex(file);
        const target = await api.resourceUploadTarget(brand, { sha256 });
        await putResourceBytes(target, file);
        await api.indexResource(brand, {
          name: file.name,
          sha256,
          size: file.size,
          // "" where the browser could not tell, which is the same empty string the wire
          // uses for a file whose type was never recorded. The filename decides from there.
          content_type: file.type,
        });
      },
      remove: async (resource) => {
        await api.deleteResource(brand, resource.name);
      },
      download: async (resource) => {
        await download(resource);
      },
      // PDFs and images are pointed AT the file store: the ticket is a plain URL an <iframe>
      // or <img> accepts, so the browser streams them with no copy in our hands. Text is
      // fetched, because text has to be read before it can be shown. No Authorization header
      // on that fetch: the ticket carries its own authority.
      preview: async (resource, kind, signal) => {
        const link = await api.resourceLink(brand, resource.name, { signal });
        if (kind !== "text") {
          return { url: link.url };
        }
        const res = await fetch(link.url, { signal });
        if (!res.ok) {
          throw new ApiError(res.status, "This file could not be opened just now");
        }
        return { text: await res.text() };
      },
    }),
    [brand, names, download],
  );

  return (
    <ResourcesShell
      resources={resources}
      loadErrorView={
        loadError !== null ? (
          <p role="alert" className="text-xs wrap-anywhere text-fail">
            {detailText(loadError)}
          </p>
        ) : null
      }
      ops={ops}
      onChanged={reload}
      renderError={(cause, fileName) => (
        <p role="alert" className="text-xs wrap-anywhere text-fail">
          {cause instanceof RefusedUpload
            ? cause.message
            : uploadFailureMessage(
                cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
                fileName,
              )}
        </p>
      )}
      copy={{
        title: "Your files",
        blurb:
          "Anything you add here is read before we write, so your own brochures, price sheets " +
          "and fact documents shape what goes into a blog. These files are yours: you add and " +
          "remove them, and we only read them.",
        dropHint: "Drop files here, or pick them yourself. Up to 25 MB each.",
        empty:
          "You have not added any files yet. Without them we research your topics from public " +
          "sources alone, so anything only you hold is worth putting here.",
        statusDone: "added",
        statusFailed: "not added",
        deleteTitle: "Remove this file?",
        deleteBody:
          "We stop reading it from the next piece we write. Blogs already written from it keep " +
          "whatever they cited, and nothing published changes.",
        deleteAction: "Remove",
        previewTagline: "Your original file, exactly as we read it.",
        previewNoneTitle: "This one opens outside the browser",
        previewNoneBody:
          "Download it to read the original in the app that owns the format. We read it either way.",
      }}
    />
  );
}

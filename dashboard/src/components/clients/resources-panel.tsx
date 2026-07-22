"use client";

import * as React from "react";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import type { Resource, ResourcesResponse } from "@/types";
import { FieldError } from "@/components/clients/engine-error";
import { ResourcesShell, type ResourceOps } from "@/components/clients/resources-shell";

/**
 * The admin console's resources tab: the shared ResourcesShell over the ENGINE transport.
 * Multipart upload through FastAPI, authenticated blob downloads and previews. The portal
 * renders the same shell over its own Storage transport (portal/resources.tsx), which is the
 * point: one surface, two wires.
 */
export function ResourcesPanel({ brandSlug }: { brandSlug: string }) {
  const [resources, setResources] = React.useState<Resource[] | null>(null);
  const [loadError, setLoadError] = React.useState<ApiError | null>(null);

  const applyLoaded = React.useCallback((data: ResourcesResponse) => {
    setResources(data.resources);
    setLoadError(null);
  }, []);

  const applyFailed = React.useCallback((cause: unknown) => {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return;
    }
    setLoadError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    setResources([]);
  }, []);

  // State is written only from the settled callbacks: the engine is an external system,
  // and `resources` starts null, which is what the skeleton renders from.
  React.useEffect(() => {
    const controller = new AbortController();
    api.resources(brandSlug, controller.signal).then(applyLoaded, applyFailed);
    return () => controller.abort();
  }, [brandSlug, applyLoaded, applyFailed]);

  const reload = React.useCallback(async () => {
    try {
      applyLoaded(await api.resources(brandSlug));
    } catch (cause) {
      applyFailed(cause);
    }
  }, [brandSlug, applyLoaded, applyFailed]);

  /**
   * The ORIGINAL uploaded file, byte for byte: the engine streams it from content-addressed
   * Storage with ?download=1. Saved through a throwaway anchor because the fetch needs the
   * Authorization header, which a plain href cannot carry.
   */
  const download = React.useCallback(
    async (resource: Resource) => {
      const blob = await api.resourceFile(brandSlug, resource.name, { download: true });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = resource.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    },
    [brandSlug],
  );

  const ops = React.useMemo<ResourceOps<Resource>>(
    () => ({
      upload: async (file) => {
        const form = new FormData();
        form.append("file", file);
        await api.uploadResource(brandSlug, form);
      },
      remove: async (resource) => {
        await api.deleteResource(brandSlug, resource.name);
        toast.success(`Deleted ${resource.name}`);
      },
      download: async (resource) => {
        try {
          await download(resource);
        } catch (cause) {
          const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
          toast.error(String(error.detail ?? error.message));
        }
      },
      // The engine endpoint requires the Authorization header, so a plain <iframe src> could
      // never load it: bytes come down as a blob and leave as an object URL the shell revokes.
      preview: async (resource, kind, signal) => {
        const blob = await api.resourceFile(brandSlug, resource.name, { signal });
        if (kind === "text") {
          return { text: await blob.text() };
        }
        return { url: URL.createObjectURL(blob), revoke: true };
      },
    }),
    [brandSlug, download],
  );

  return (
    <ResourcesShell
      resources={resources}
      loadErrorView={loadError !== null ? <FieldError error={loadError} /> : null}
      ops={ops}
      onChanged={reload}
      readOnly={HOSTED_READONLY}
      renderError={(cause) => (
        <FieldError
          error={cause instanceof ApiError ? cause : new ApiError(0, String(cause), null)}
        />
      )}
    />
  );
}

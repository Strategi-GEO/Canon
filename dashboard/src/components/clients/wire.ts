/**
 * Where src/types and the live engine disagree, this file bridges the two.
 *
 * One divergence exists today, verified against server/clients.py and server/app.py:
 * Resource carries `uploaded` on the wire, `modified` in src/types.
 *
 * Organisation is deliberately NOT bridged here. src/types models it, and GET /api/orgs is
 * the authority on the grouping: a second copy of that logic in this file could disagree
 * with the engine's, which is the exact drift the derived-not-stored design exists to stop.
 *
 * src/types is owned elsewhere, so this file adapts rather than redeclares: nothing here
 * invents a shape, it only names the one the server actually sends.
 */

import { api } from "@/lib/api";
import type { Client, CreateClientBody, Preflight, Resource, UpdateClientBody } from "@/types";

/**
 * Preflight rides on the LIST response only. server/app.py decorates each entry of
 * GET /api/clients with it, and GET /api/clients/{slug} returns the record without it.
 * src/types marks the field required, so reading it straight off a singly fetched client
 * yields undefined and throws on `.ok`. The list copy is the one that is really there.
 */
export function preflightOf(client: Client, listed?: Client | null): Preflight | null {
  const own = (client as Partial<Client>).preflight;
  if (own && typeof own.ok === "boolean") {
    return own;
  }
  return listed?.preflight ?? null;
}

export function createClient(body: CreateClientBody): Promise<Client> {
  return api.createClient(body);
}

export function updateClient(slug: string, body: UpdateClientBody): Promise<Client> {
  return api.updateClient(slug, body);
}

/** The upload timestamp, from whichever key this engine build sends. */
export function uploadedAt(resource: Resource): string {
  const wire = resource as Resource & { uploaded?: string };
  return wire.uploaded ?? resource.modified ?? "";
}

/** Bytes, rendered short. The engine reports st_size, so this is an exact count. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** An ISO timestamp shown as a plain date. Invalid input falls back to the raw string. */
export function formatDate(iso: string): string {
  if (!iso) {
    return "";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toISOString().slice(0, 10);
}

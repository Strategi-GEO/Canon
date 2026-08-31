"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { useOrgs } from "@/lib/orgs-context";
import { useDescribe } from "@/lib/describe-context";
import { FieldError } from "@/components/clients/engine-error";
import { createClient } from "@/components/clients/wire";
import { PortalCredentialsDialog } from "@/components/clients/portal-credentials";
import type { Client, PortalCredential } from "@/types";

/**
 * Adds an ORGANISATION, together with its first brand, in one step.
 *
 * An org is DERIVED from the brands that exist and is never stored empty, so "add an
 * organisation" necessarily means "add its first brand". This dialog is the org-first mirror of
 * AddBrandDialog: the operator names the ORG first, and the brand is only asked for when the org
 * genuinely holds more than one. Both paths hit the SAME endpoint AddBrandDialog does, POST
 * /api/clients, so the engine writes the orgs row and the clients row and links them by org_id
 * exactly as it does for a brand. There is no second write path and no org-only table.
 *
 * The two shapes it sends:
 *  - Single brand (the common case): the org IS the brand, so the brand's name is the org's name
 *    and NO organisation_name is sent. The engine derives a single-brand org from the client
 *    itself, which is how a brand states that it stands alone.
 *  - Multiple brands: organisation_name is the explicit org, and the brand carries its own name.
 *    The engine upserts the orgs row and points the client's org_id at it. Naming an org that
 *    already exists files this first brand under it rather than creating a duplicate.
 */
export function AddOrganisationDialog({
  open,
  onOpenChange,
  trigger,
  onCreated,
}: {
  /**
   * Controlled open. Provided by callers that open this from another overlay (the org switcher
   * closes its popover, then opens this), so no DialogTrigger is rendered in that mode.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A custom trigger, for the sidebar's nav-styled row. Ignored in controlled mode. */
  trigger?: React.ReactNode;
  /** The caller owns what happens next, because the caller owns the URL space. */
  onCreated?: (brand: Client) => void;
}) {
  const controlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(false);
  const actualOpen = controlled ? open : internalOpen;

  const [orgName, setOrgName] = React.useState("");
  const [multiBrand, setMultiBrand] = React.useState(false);
  const [brandName, setBrandName] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  // The one-time portal login to reveal, held until the admin acknowledges it. When set, the
  // redirect that onCreated runs is deferred to the reveal's Done, so a one-time password is
  // never skipped past by a navigation firing underneath it.
  const [reveal, setReveal] = React.useState<{ credential: PortalCredential; brand: Client } | null>(
    null,
  );

  const { orgs } = useOrgs();
  const { start: startDescribe } = useDescribe();
  const checkboxId = React.useId();

  // After every hook, so the hook order stays constant. Creating an org is an engine write
  // (POST /api/clients plus the describe session), so the hosted, read-only build has nothing
  // to render here, trigger or controlled content alike.
  if (HOSTED_READONLY) {
    return null;
  }

  function reset() {
    setOrgName("");
    setMultiBrand(false);
    setBrandName("");
    setDomain("");
    setError(null);
  }

  function setOpen(next: boolean) {
    if (!controlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
    if (!next) {
      reset();
    }
  }

  const trimmedOrg = orgName.trim();
  // The org grouping is by lowercased name, matching the engine's slugify-and-match, so a typed
  // name that already exists files this brand under that org rather than minting a near duplicate.
  const existingOrg = orgs.find((org) => org.name.toLowerCase() === trimmedOrg.toLowerCase());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    // Single brand: the brand IS the org, so it carries the org's name and sends no
    // organisation_name. Multiple brands: the explicit org holds a separately named first brand.
    const firstBrandName = multiBrand ? brandName.trim() : trimmedOrg;

    try {
      const brand = await createClient({
        name: firstBrandName,
        domain: domain.trim(),
        // Industry is no longer picked here: the describe session detects it from the site right
        // after the brand exists and writes it to the record, exactly like the description.
        industry: "",
        ...(multiBrand ? { organisation_name: trimmedOrg } : {}),
      });
      toast.success(
        multiBrand ? `Added ${trimmedOrg} with ${brand.name}` : `Added ${brand.name}`,
      );
      setOpen(false);
      // A fresh org gets its client login here, and the password is shown once. Hold the
      // redirect until the admin acknowledges it; a brand joining an existing org mints no login
      // (portal_login is null), so it proceeds straight through as before.
      //
      // THE DESCRIBE DRAFT IS HELD BACK WITH IT, and that is the point rather than tidiness. A
      // settling draft calls useOrgs().refresh() (see describe-context), the refreshed list gives
      // this org its first brand, and OrgPage's single-brand redirect then fires router.replace
      // and unmounts the reveal mid-read. The password is shown exactly once and cannot be read
      // back, so a navigation under that dialog loses it for good. Nothing is started until the
      // admin has it.
      if (brand.portal_login) {
        setReveal({ credential: brand.portal_login, brand });
      } else {
        void startDescribe(brand.slug);
        onCreated?.(brand);
      }
    } catch (cause) {
      // 409 names the slug that already exists and 422 names the field, so the engine's own
      // sentence reaches the operator verbatim.
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSubmitting(false);
    }
  }

  // The client slug the engine derives, and so the field a 409 (slug collision) or 422 (name
  // problem) is about, is the org's name when the org stands alone and the brand's name when it
  // does not. Mark that field, and show the engine's full sentence once below the form.
  const identityError = error && (error.status === 409 || error.status === 422) ? error : null;

  return (
    <>
    <Dialog open={actualOpen} onOpenChange={setOpen}>
      {controlled ? null : (
        <DialogTrigger asChild>
          {trigger ?? (
            <Button size="sm">
              <Plus data-icon="inline-start" aria-hidden />
              Add organisation
            </Button>
          )}
        </DialogTrigger>
      )}

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an organisation</DialogTitle>
          <DialogDescription>
            An organisation is the agency&apos;s client, above the brand. It is a grouping only:
            the brand holds the facts, the resources, and the roadmap the factory writes from.
            Adding an organisation creates its first brand too, and that brand&apos;s canonical
            facts still need a human review before it can generate real blogs.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="org-name">Organisation name</Label>
            <Input
              id="org-name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Vacation Village"
              required
              autoComplete="off"
              aria-invalid={!multiBrand && identityError ? true : undefined}
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {existingOrg ? (
                <>
                  An organisation named{" "}
                  <span className="font-medium text-foreground">{existingOrg.name}</span> already
                  exists, with <span className="machine">{existingOrg.brands.length}</span>{" "}
                  {existingOrg.brands.length === 1 ? "brand" : "brands"}. This files the new brand
                  under it.
                </>
              ) : (
                "The agency's client. If it runs a single brand, that brand takes this name and its slug is derived from it."
              )}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <div className="flex items-start gap-2.5">
              <Checkbox
                id={checkboxId}
                checked={multiBrand}
                onCheckedChange={(next) => setMultiBrand(next === true)}
                className="mt-0.5"
              />
              <div className="min-w-0">
                <Label htmlFor={checkboxId} className="font-medium">
                  This organisation has multiple brands
                </Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Leave this off when the organisation is a single brand, which is the usual
                  case. Turn it on to name the first brand separately from the organisation.
                </p>
              </div>
            </div>

            {/* Revealed only when the org genuinely holds more than one brand. Asking for an
                organisation name and a brand name up front makes the operator type the same word
                twice for nearly every client, so the uncommon case stays one checkbox away. */}
            {multiBrand ? (
              <div className="mt-3">
                <Label htmlFor="org-brand-name">First brand name</Label>
                <Input
                  id="org-brand-name"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="Vacation Village Chikkamagaluru"
                  required
                  autoComplete="off"
                  aria-invalid={identityError ? true : undefined}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The first brand under {trimmedOrg === "" ? "this organisation" : trimmedOrg}. Its
                  slug is derived from this name and is permanent. You can add more brands later.
                </p>
              </div>
            ) : null}
          </div>

          <div>
            <Label htmlFor="org-domain">Brand website</Label>
            <Input
              id="org-domain"
              type="url"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="https://vacationvillage.co.in/"
              required
              autoComplete="off"
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The live site of the first brand. It wins over internal docs on any conflict, so
              this is what the researcher fetches first.
            </p>
          </div>

          {/* No industry picker and no description field on purpose. The moment the organisation
              is added, Claude reads the brand website and writes BOTH the description and the
              detected industry to the record automatically. Neither is typed here. An "Others"
              bucket is used when the site fits none of the known industries. */}
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            The description and the industry are detected automatically from the brand website once
            you add the organisation, so there is nothing to pick or write here.
          </p>

          {error ? <FieldError error={error} /> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : null}
              Add organisation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    {/* Rendered outside the form Dialog so it survives that dialog closing. onDone runs the
        deferred redirect, so the operator lands on the new brand only after saving the login. */}
    <PortalCredentialsDialog
      credential={reveal?.credential ?? null}
      brandName={reveal?.brand.name ?? ""}
      onDone={() => {
        const brand = reveal?.brand ?? null;
        setReveal(null);
        if (brand) {
          // Deferred from submit: see the note there. Started before onCreated so the draft is
          // already in flight by the time the redirect lands on the brand's page.
          void startDescribe(brand.slug);
          onCreated?.(brand);
        }
      }}
    />
    </>
  );
}

"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { useDescribe } from "@/lib/describe-context";
import { FieldError } from "@/components/clients/engine-error";
import { createClient } from "@/components/clients/wire";
import { PortalCredentialsDialog } from "@/components/clients/portal-credentials";
import type { Client, PortalCredential } from "@/types";

/**
 * Adds a BRAND, optionally inside an ORG.
 *
 * The org is a grouping, so it is just a name: leaving it blank makes the brand its own
 * single-brand org, which is the common case and needs no migration. Typing an existing org's
 * name files the brand under it. There is no orgs/ directory to create first, because the
 * grouping is derived from the brands themselves.
 */
export function AddBrandDialog({
  organisations,
  defaultOrganisationName = "",
  lockOrganisation = false,
  onCreated,
}: {
  /** Org names already in use, offered as suggestions. */
  organisations: string[];
  /** Prefills the org, for an Add brand button that already sits inside one. */
  defaultOrganisationName?: string;
  /** Locks the org field: adding a brand from inside an org cannot mean another org. */
  lockOrganisation?: boolean;
  /** The route decides what happens next, because the route owns the URL space. */
  onCreated?: (brand: Client) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [organisation, setOrganisation] = React.useState(defaultOrganisationName);
  const [domain, setDomain] = React.useState("");
  // Prefilled with the house default (HOUSE_DEFAULT_MARKET in server/clients.py, which also
  // falls back to it on a blank): every brand this agency serves sells in India in English,
  // so the field is visible and editable but never demands typing for the common case.
  const [market, setMarket] = React.useState("India, English");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  // The one-time portal login to reveal, held until the admin acknowledges it. A brand that is
  // its own new single-brand org mints a login and reveals it here; a brand joining an existing
  // org mints none (portal_login null) and skips it. See PortalCredentialsDialog.
  const [reveal, setReveal] = React.useState<{ credential: PortalCredential; brand: Client } | null>(
    null,
  );

  const { start: startDescribe } = useDescribe();
  const listId = React.useId();

  // After every hook, so the hook order stays constant. Creating a brand is an engine write
  // (POST /api/clients plus the describe session), so the hosted build has no Add button.
  if (HOSTED_READONLY) {
    return null;
  }

  function reset() {
    setName("");
    setOrganisation(defaultOrganisationName);
    setDomain("");
    setMarket("India, English");
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const brand = await createClient({
        name: name.trim(),
        domain: domain.trim(),
        // Industry is detected from the site by the describe session, exactly like the
        // description, so it is not asked here.
        industry: "",
        // The market is NOT detected: the engine contract forbids guessing it from the
        // domain, and DataForSEO is skipped on every run for a brand without one, so it is
        // the one field only a human can supply and it is asked here.
        market: market.trim(),
        // Blank is meaningful: it tells the engine to write no organisation key, which is
        // exactly how a brand states that it is its own single-brand org.
        organisation_name: organisation.trim(),
      });
      toast.success(`Added ${brand.name}`);
      setOpen(false);
      reset();
      // A brand that is its own new org gets its client login here, shown once. Hold the redirect
      // until the admin saves it; a brand joining an org that already has a login skips this.
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
      // 409 names the slug that already exists and 422 names the field, so the engine's
      // sentence goes next to the field it is about rather than into a generic banner.
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSubmitting(false);
    }
  }

  // 409 is always a slug collision and 422 is usually a name problem, both of which the
  // engine derives from Name, so both belong under that field. The one exception is an org
  // name with no letter or digit in it, which the engine also answers with a 422.
  const nameError = error && (error.status === 409 || error.status === 422) ? error : null;
  const generalError = error && !nameError ? error : null;

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus data-icon="inline-start" aria-hidden />
          Add brand
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a brand</DialogTitle>
          <DialogDescription>
            A brand holds the facts, the resources, and the roadmap the factory writes from,
            and it is the only thing blogs are created under. Its canonical facts still need a
            human review before it can generate real blogs.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="brand-name">Name</Label>
            <Input
              id="brand-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Vacation Village"
              required
              autoComplete="off"
              aria-invalid={nameError ? true : undefined}
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The slug is derived from the name and is permanent.
            </p>
            {nameError ? <FieldError error={nameError} /> : null}
          </div>

          <div>
            <Label htmlFor="brand-organisation">Organisation</Label>
            {/* A native combobox: pick an org that exists or type a new one. An org is only a
                name, so there is nothing to create first and no list to keep in step. */}
            <Input
              id="brand-organisation"
              list={listId}
              value={organisation}
              onChange={(e) => setOrganisation(e.target.value)}
              placeholder="Leave blank if this brand stands alone"
              autoComplete="off"
              disabled={lockOrganisation}
              className="mt-1.5"
            />
            <datalist id={listId}>
              {organisations.map((org) => (
                <option key={org} value={org} />
              ))}
            </datalist>
            <p className="mt-1 text-xs text-muted-foreground">
              The agency&apos;s client, above the brand. Pick one that exists or type a new
              one. Blank means this brand is its own organisation, which is the usual case.
            </p>
          </div>

          <div>
            <Label htmlFor="brand-domain">Domain</Label>
            <Input
              id="brand-domain"
              type="url"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="https://vacationvillage.co.in/"
              required
              autoComplete="off"
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The live site wins over internal docs on any conflict, so this is what the
              researcher fetches first.
            </p>
          </div>

          <div>
            <Label htmlFor="brand-market">Market</Label>
            <Input
              id="brand-market"
              value={market}
              onChange={(e) => setMarket(e.target.value)}
              placeholder="India, English"
              required
              autoComplete="off"
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Where this brand sells and in what language. Keyword volumes are validated
              against this market and the researcher prefers sources local to it. Prefilled
              with the house default; change it only if this brand sells elsewhere.
            </p>
          </div>

          {/* No industry picker and no description field on purpose. The moment the brand is
              added, Claude reads the brand website and writes BOTH the description and the
              detected industry to the record automatically. Neither is typed here. */}
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            The description and the industry are detected automatically from the brand website
            once you add the brand, so there is nothing to pick or write here.
          </p>

          {generalError ? <FieldError error={generalError} /> : null}

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
              Add brand
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    {/* Outside the form Dialog so it survives that dialog closing. onDone runs the deferred
        redirect, so the operator lands on the new brand only after saving the login. */}
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

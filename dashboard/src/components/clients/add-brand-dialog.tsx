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
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import { useOrgs } from "@/lib/orgs-context";
import { useDescribe } from "@/lib/describe-context";
import { FieldError } from "@/components/clients/engine-error";
import { createClient } from "@/components/clients/wire";
import type { Client } from "@/types";

/** The engine reads these off disk, so a hardcoded list would drift the moment one lands. */
function useIndustries(open: boolean) {
  const [industries, setIndustries] = React.useState<string[]>([]);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    api.industries(controller.signal).then(
      (data) => setIndustries(data.industries),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
      },
    );
    return () => controller.abort();
  }, [open]);

  return { industries, error };
}

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
  const [industry, setIndustry] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const { geoMock } = useOrgs();
  const { start: startDescribe } = useDescribe();
  const { industries, error: industriesError } = useIndustries(open);
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
    setIndustry("");
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
        industry,
        // Blank is meaningful: it tells the engine to write no organisation key, which is
        // exactly how a brand states that it is its own single-brand org.
        organisation_name: organisation.trim(),
      });
      toast.success(`Added ${brand.name}`);
      // Start the description draft the instant the brand exists, so the operator never has to
      // type one or press Draft with Claude. The session lives in DescribeProvider above every
      // route, so it survives closing this dialog and the redirect that follows, and the draft
      // lands on the brand's page for review. Skipped under mock and demo, where describe can
      // only return a placeholder that must not be saved.
      if (!geoMock && !brand.demo_mode) {
        void startDescribe(brand.slug);
      }
      setOpen(false);
      reset();
      onCreated?.(brand);
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
            <Label htmlFor="brand-industry">Industry</Label>
            <select
              id="brand-industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              required
              className={cn(
                "mt-1.5 h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              )}
            >
              <option value="" disabled>
                Select an industry
              </option>
              {industries.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Picks the industry reference the writer loads. Skipping it produces generic
              content.
            </p>
            {industriesError ? <FieldError error={industriesError} /> : null}
          </div>

          {/* No description field on purpose. The moment the brand is added, Claude reads the
              brand website and writes the description to the record automatically. It is not
              typed here and it is not editable later. */}
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
            The description is generated automatically from the website once you add the brand,
            so there is nothing to write here.
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
  );
}

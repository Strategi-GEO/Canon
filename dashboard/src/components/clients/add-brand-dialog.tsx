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
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FieldError } from "@/components/clients/engine-error";
import {
  NEVER_CLAIM_EXPLAINER,
  NEVER_CLAIM_PLACEHOLDER,
} from "@/components/clients/never-claim-help";
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
  const [description, setDescription] = React.useState("");
  const [neverClaim, setNeverClaim] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const { industries, error: industriesError } = useIndustries(open);
  const listId = React.useId();

  function reset() {
    setName("");
    setOrganisation(defaultOrganisationName);
    setDomain("");
    setIndustry("");
    setDescription("");
    setNeverClaim("");
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
        description: description.trim(),
        never_claim: neverClaim.trim(),
        // Blank is meaningful: it tells the engine to write no organisation key, which is
        // exactly how a brand states that it is its own single-brand org.
        organisation_name: organisation.trim(),
      });
      toast.success(`Added ${brand.name}`);
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

          <div>
            <Label htmlFor="brand-description">Description</Label>
            <Textarea
              id="brand-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What this brand is, what it sells, and who it sells to."
              className="mt-1.5"
            />
            {/* Draft with Claude reads the SAVED brand's domain, and POST describe answers
                404 for a slug that does not exist yet. So the draft runs on the brand page
                once this form has created it. Wiring a button here that could only 404 would
                be a fake feature, and this engine's whole point is not faking. */}
            <p className="mt-1 text-xs text-muted-foreground">
              Add the brand, then use Draft with Claude on its page to draft this from the
              live site. Nothing a draft produces is ever saved without your review.
            </p>
          </div>

          <div>
            <Label htmlFor="brand-never-claim">Never claim</Label>
            <p className="mt-1 text-xs text-muted-foreground">{NEVER_CLAIM_EXPLAINER}</p>
            <Textarea
              id="brand-never-claim"
              value={neverClaim}
              onChange={(e) => setNeverClaim(e.target.value)}
              rows={5}
              placeholder={NEVER_CLAIM_PLACEHOLDER}
              className="machine mt-1.5 text-xs"
            />
          </div>

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

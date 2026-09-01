"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { brandLocationHref, useActiveOrg, useOrgs } from "@/lib/orgs-context";
import { useDescribe } from "@/lib/describe-context";
import { FieldError } from "@/components/clients/engine-error";
import { createClient } from "@/components/clients/wire";
import { AddOrganisationDialog } from "@/components/clients/add-organisation-dialog";

/**
 * The one onboarding route, serving BOTH flows the operator has words for. It exists as a full
 * page rather than a dialog because this is the one flow that runs when the app is empty and /
 * sends the operator straight here: a dialog needs a page behind it to open over, and there
 * would not be one.
 *
 * An ORGANISATION and a CLIENT are the same thing here: the agency's client, above the brand.
 * There is one endpoint behind everything, POST /api/clients, and an org is DERIVED from the
 * clients that exist rather than stored on its own, so "add an organisation" necessarily means
 * "add its first brand". The two flows differ only by ?org=:
 *  - no ?org=: add an organisation and its first brand, org-first. Reuses AddOrganisationDialog
 *    so the app has exactly ONE organisation form and it can never drift from the one the org
 *    switcher and sidebar open.
 *  - ?org=<name>: add another brand to that existing organisation, org locked.
 */
export default function NewClientPage() {
  // Onboarding is an engine write (POST /api/clients plus the describe session), so the hosted,
  // read-only build states that instead of rendering a form that can only be refused.
  if (HOSTED_READONLY) {
    return (
      <div className="mx-auto w-full max-w-lg">
        <Card className="mt-8">
          <CardContent className="py-14 text-center">
            <p className="text-sm font-medium text-foreground">
              Organisations are onboarded from the operator dashboard
            </p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
              This dashboard is the read-only view of the factory&apos;s record. Adding an
              organisation creates its record and starts engine sessions, so it happens where the
              engine runs.
            </p>
            <Button size="sm" variant="outline" className="mt-6" asChild>
              <Link href="/admin">Back to the dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg">
      <React.Suspense fallback={null}>
        <NewForm />
      </React.Suspense>
    </div>
  );
}

/** ?org= is the only thing telling the two flows apart, so the split lives here, before either
 *  child mounts its own hooks. */
function NewForm() {
  const searchParams = useSearchParams();
  const joiningOrg = searchParams.get("org")?.trim() ?? "";
  return joiningOrg === "" ? (
    <OrganisationBootstrap />
  ) : (
    <AddBrandToOrgForm joiningOrg={joiningOrg} />
  );
}

/**
 * The empty-app landing: name an organisation and its first brand. It reuses the very dialog the
 * org switcher and sidebar open, so there is one organisation form and one org-first flow across
 * the whole app. The dialog opens on arrival; the card behind it is the way back in after a
 * Cancel.
 */
function OrganisationBootstrap() {
  const router = useRouter();
  const { refresh } = useOrgs();
  const [open, setOpen] = React.useState(true);

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Add an organisation
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          An organisation is the agency&apos;s client, above the brand. Most run a single brand,
          so this adds the organisation and its first brand together. Its canonical facts still
          need a human review before it can generate real blogs.
        </p>
      </div>

      <Card>
        <CardContent className="py-10 text-center">
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            Name the organisation and its first brand&apos;s website. If the organisation runs
            more than one brand, name the first brand separately.
          </p>
          <div className="mt-5 flex justify-center">
            <Button size="sm" onClick={() => setOpen(true)}>
              Add organisation
            </Button>
          </div>
        </CardContent>
      </Card>

      <AddOrganisationDialog
        open={open}
        onOpenChange={setOpen}
        onCreated={(brand) => {
          // The address comes from the created record itself, so the redirect does not wait on
          // the orgs list; refresh only repopulates the nav behind it.
          void refresh();
          router.push(brandLocationHref(brand));
        }}
      />
    </>
  );
}

/**
 * ?org= mode: add another brand to an organisation that already exists. The org is settled, so it
 * is stated rather than asked, and the piece the operator fills in is the brand.
 */
function AddBrandToOrgForm({ joiningOrg }: { joiningOrg: string }) {
  const router = useRouter();
  const { refresh } = useOrgs();
  const { start: startDescribe } = useDescribe();
  // The same org the sidebar and the switcher are showing, resolved once for all three.
  const existingOrg = useActiveOrg();

  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const trimmedName = name.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    // Omitted only when the brand's own name IS the org's name: the engine then derives exactly
    // that org from the brand itself, so sending it would state the default twice. Every other
    // brand names its org explicitly, so a brand whose name happened to match would not derive a
    // DIFFERENT bucket than the one the operator chose.
    const ownOrg = joiningOrg.toLowerCase() === trimmedName.toLowerCase();

    try {
      const client = await createClient({
        name: trimmedName,
        domain: domain.trim(),
        // Industry is detected from the site by the describe session, exactly like the
        // description, so it is not asked here.
        industry: "",
        ...(ownOrg ? {} : { organisation_name: joiningOrg }),
      });
      toast.success(`Added ${client.name}`);

      // Start the description AND industry draft the instant the brand exists, so the operator
      // never has to type either or press Draft with Claude. The session runs in DescribeProvider
      // above every route, so it survives this redirect and lands on the brand's page for review.
      void startDescribe(client.slug);

      // The address comes from the created record itself, so the redirect does not wait on the
      // orgs list; refresh only repopulates the nav behind it.
      void refresh();
      router.push(brandLocationHref(client));
    } catch (cause) {
      // 409 names the slug that already exists and 422 names the field, so the engine's own
      // sentence goes next to the field it is about rather than into a generic banner.
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
      setSubmitting(false);
    }
  }

  // 409 is always a slug collision and 422 is always a name problem, both of which the engine
  // derives from Brand name, so both belong under that field.
  const nameError = error && (error.status === 409 || error.status === 422) ? error : null;
  const generalError = error && !nameError ? error : null;

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Add a brand to {joiningOrg}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A brand is one company the factory writes for. It keeps its own canonical facts,
          resources and roadmap, and shares none of them with the other brands in {joiningOrg}.
        </p>
      </div>

      <Card>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="new-name">Brand name</Label>
              <Input
                id="new-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Vacation Village Chikkamagaluru"
                required
                autoComplete="off"
                aria-invalid={nameError ? true : undefined}
                className="mt-1.5"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                The company or product line the engine writes for. Its slug is derived from this
                name and is permanent.
              </p>
              {nameError ? <FieldError error={nameError} /> : null}
            </div>

            <OrgLocked orgName={joiningOrg} known={existingOrg !== null} />

            <div>
              <Label htmlFor="new-domain">Brand website</Label>
              <Input
                id="new-domain"
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

            {/* No industry picker and no description field on purpose. The moment the brand is
                added, Claude reads the brand website and writes BOTH the description and the
                detected industry to the record automatically. Neither is typed here. */}
            <p className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
              The description and the industry are detected automatically from the brand website
              once you add the brand, so there is nothing to pick or write here.
            </p>

            {generalError ? <FieldError error={generalError} /> : null}

            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                ) : null}
                Add brand
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => router.push("/admin")}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Brand mode: the org is settled, so it is stated rather than asked. Arriving here means the
 * operator pressed "Add brand to <org>", and re-asking a question they already answered is how a
 * brand ends up filed under the wrong org.
 */
function OrgLocked({ orgName, known }: { orgName: string; known: boolean }) {
  return (
    <div>
      <Label>Organisation</Label>
      <div className="mt-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-2">
        <p className="truncate text-sm text-foreground">{orgName}</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {known
          ? `This brand joins ${orgName}. It is a grouping only: brands never share canonical facts or a roadmap. `
          : `No organisation named ${orgName} exists yet, so adding this brand creates it. `}
        <Link href="/admin/new" className="underline underline-offset-4 hover:text-foreground">
          Add an organisation instead
        </Link>
      </p>
    </div>
  );
}

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
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import { brandHref, useOrgs } from "@/lib/orgs-context";
import { useDescribe } from "@/lib/describe-context";
import { FieldError } from "@/components/clients/engine-error";
import { createClient } from "@/components/clients/wire";
import { OrgCombobox } from "@/components/shell/org-combobox";

/**
 * The one creation route, serving BOTH flows the operator has words for.
 *
 * There is one endpoint behind them: POST /api/clients. An organisation is DERIVED from the
 * clients that exist and is never stored on its own, so an org cannot be created empty and
 * "add an organisation" necessarily means "add its first brand". The two flows differ only in
 * whether organisation_name is sent:
 *  - no ?org=: the brand becomes its own single-brand org. The common case.
 *  - ?org=<name>: the brand joins that existing org.
 *
 * A full page rather than a dialog, because this is the one flow that runs when the app is
 * empty and / sends the operator straight here. A dialog needs a page behind it to open over,
 * and there would not be one.
 */
export default function NewClientPage() {
  // Onboarding is an engine write (POST /api/clients plus the describe session), so the
  // hosted, read-only build states that instead of rendering a form that can only be refused.
  if (HOSTED_READONLY) {
    return (
      <div className="mx-auto w-full max-w-lg">
        <Card className="mt-8">
          <CardContent className="py-14 text-center">
            <p className="text-sm font-medium text-foreground">
              Clients are onboarded from the operator dashboard
            </p>
            <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
              This dashboard is the read-only view of the factory&apos;s record. Adding a
              client creates its record and starts engine sessions, so it happens where the
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
        <NewClientForm />
      </React.Suspense>
    </div>
  );
}

function NewClientForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh, findBrand, orgs, geoMock } = useOrgs();
  const { start: startDescribe } = useDescribe();

  // Set when this came from "Add brand to <org>". Its presence IS the mode: it decides the
  // heading, the copy, and whether the org is the operator's to choose here at all.
  const joiningOrg = searchParams.get("org")?.trim() ?? "";
  const mode: "brand" | "client" = joiningOrg === "" ? "client" : "brand";

  const [name, setName] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [industry, setIndustry] = React.useState("");
  const [description, setDescription] = React.useState("");
  // Only reachable in client mode, and only when the operator asks for it. An org that is
  // just the brand's name again is the default, so it is never a question worth asking first.
  const [customOrg, setCustomOrg] = React.useState("");
  const [choosingOrg, setChoosingOrg] = React.useState(false);
  const [industries, setIndustries] = React.useState<string[]>([]);
  const [industriesError, setIndustriesError] = React.useState<ApiError | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  // The engine reads these off disk, so a hardcoded list would drift the moment one lands.
  React.useEffect(() => {
    const controller = new AbortController();
    api.industries(controller.signal).then(
      (data) => setIndustries(data.industries),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setIndustriesError(
          cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
        );
      },
    );
    return () => controller.abort();
  }, []);

  const trimmedName = name.trim();
  const existingOrg = orgs.find((org) => org.name.toLowerCase() === joiningOrg.toLowerCase());

  /**
   * The org this brand lands in, as a name the engine slugifies and matches.
   *
   * Brand mode always names it: the operator picked that org explicitly, and a brand whose own
   * name happened to match would otherwise derive an org from its OWN slug and quietly land in
   * a different bucket than the one they chose.
   */
  function organisationName(): string {
    if (mode === "brand") {
      return joiningOrg;
    }
    return choosingOrg && customOrg.trim() !== "" ? customOrg.trim() : trimmedName;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const org = organisationName();
    // Omitted when the org is just this brand under its own name. The engine derives exactly
    // that org from the brand itself, so sending it would store a field to state what the
    // default already states.
    const ownOrg = org.toLowerCase() === trimmedName.toLowerCase();

    try {
      const client = await createClient({
        name: trimmedName,
        domain: domain.trim(),
        industry,
        description: description.trim(),
        ...(ownOrg ? {} : { organisation_name: org }),
      });
      toast.success(`Added ${client.name}`);

      // Start the description draft the instant the brand exists, so the operator never has to
      // type one or press Draft with Claude. The session runs in DescribeProvider above every
      // route, so it survives this redirect and lands on the brand's page for review. Skipped
      // under mock and demo, where describe can only return a placeholder that must not be saved.
      if (!geoMock && !client.demo_mode) {
        void startDescribe(client.slug);
      }

      // The org grouping is derived from the client list, so the new brand only has an org to
      // route to once the list has been re-read.
      await refresh();
      const located = findBrand(client.slug);
      router.push(
        located
          ? brandHref(located.org.slug, located.brand.slug)
          : // The engine accepted it, so the brand exists even if this browser has not seen
            // the grouping yet. Root resolves an org rather than guessing one here.
            "/",
      );
    } catch (cause) {
      // 409 names the slug that already exists and 422 names the field, so the engine's own
      // sentence goes next to the field it is about rather than into a generic banner.
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
      setSubmitting(false);
    }
  }

  // 409 is always a slug collision and 422 is always a name problem, both of which the
  // engine derives from Brand name, so both belong under that field.
  const nameError = error && (error.status === 409 || error.status === 422) ? error : null;
  const generalError = error && !nameError ? error : null;

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          {mode === "brand" ? `Add a brand to ${joiningOrg}` : "Add a client"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "brand"
            ? `A brand is one company the factory writes for. It keeps its own canonical facts, resources and roadmap, and shares none of them with the other brands in ${joiningOrg}.`
            : "A client is one organisation and the first brand under it. Most clients are one of each, so this adds both in a single step. Its canonical facts still need a human review before it can generate real blogs."}
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
                The company or product line the engine writes for. Its slug is derived from
                this name and is permanent.
              </p>
              {nameError ? <FieldError error={nameError} /> : null}
            </div>

            {mode === "brand" ? (
              <OrgLocked orgName={joiningOrg} known={existingOrg !== undefined} />
            ) : (
              <OrgChoice
                brandName={trimmedName}
                choosing={choosingOrg}
                value={customOrg}
                onValue={setCustomOrg}
                onChoose={() => setChoosingOrg(true)}
                onDefault={() => {
                  setChoosingOrg(false);
                  setCustomOrg("");
                }}
              />
            )}

            <div>
              <Label htmlFor="new-domain">Domain</Label>
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

            <div>
              <Label htmlFor="new-industry">Industry</Label>
              <select
                id="new-industry"
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
              <Label htmlFor="new-description">Description</Label>
              <Textarea
                id="new-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="What this brand is, what it sells, and who it sells to."
                className="mt-1.5"
              />
              {/* Leave this blank: describe reads the SAVED brand's domain and 404s for a slug
                  that does not exist yet, so the draft cannot run until the brand is created.
                  Adding the brand starts it automatically, and the draft lands on the brand's
                  page for review. Nothing a draft produces is saved without that review. */}
              <p className="mt-1 text-xs text-muted-foreground">
                Optional. Leave it blank and Claude drafts one from the live site the moment
                you add the brand. The draft waits on the brand&apos;s page for your review, and
                nothing is saved without it.
              </p>
            </div>

            {generalError ? <FieldError error={generalError} /> : null}

            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                ) : null}
                {mode === "brand" ? "Add brand" : "Add client"}
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
 * operator pressed "Add brand to <org>", and re-asking a question they already answered is
 * how a brand ends up filed under the wrong org.
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
          Add a client instead
        </Link>
      </p>
    </div>
  );
}

/**
 * Client mode: the org defaults to the brand's own name and says so.
 *
 * Asking for an organisation and a brand as two required fields makes the operator reason
 * about a data model in order to type the same word twice, which is the shape of nearly every
 * client here. The uncommon case stays one click away rather than in everyone's path.
 */
function OrgChoice({
  brandName,
  choosing,
  value,
  onValue,
  onChoose,
  onDefault,
}: {
  brandName: string;
  choosing: boolean;
  value: string;
  onValue: (value: string) => void;
  onChoose: () => void;
  onDefault: () => void;
}) {
  if (choosing) {
    return (
      <div>
        <Label htmlFor="new-org">Organisation</Label>
        <OrgCombobox id="new-org" value={value} onChange={onValue} className="mt-1.5" />
        <p className="mt-1 text-xs text-muted-foreground">
          The client this brand belongs to. Pick an existing one or type a new name.{" "}
          <button
            type="button"
            onClick={onDefault}
            className="underline underline-offset-4 hover:text-foreground"
          >
            Use the brand name instead
          </button>
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
      <p className="text-xs text-muted-foreground">
        {brandName === "" ? (
          "This brand will be its own organisation."
        ) : (
          <>
            This brand will be its own organisation, named{" "}
            <span className="font-medium text-foreground">{brandName}</span>.
          </>
        )}{" "}
        <button
          type="button"
          onClick={onChoose}
          className="underline underline-offset-4 hover:text-foreground"
        >
          Add it to a different organisation
        </button>
      </p>
    </div>
  );
}

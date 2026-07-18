"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import { useOrgs } from "@/lib/orgs-context";
import { BrandRoute } from "@/components/shell/brand-route";
import { EditableText } from "@/components/clients/editable-text";
import { FieldError } from "@/components/clients/engine-error";
import { updateClient } from "@/components/clients/wire";
import { OrgCombobox } from "@/components/shell/org-combobox";
import type { Client } from "@/types";

export default function SettingsPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <BrandSettings key={brand.slug} orgName={org.name} brand={brand} />
      )}
    </BrandRoute>
  );
}

function BrandSettings({ orgName, brand }: { orgName: string; brand: Client }) {
  const { refresh } = useOrgs();
  const client = brand;

  // No local copy of the brand: the org grouping is DERIVED from these fields, so a save has
  // to reach the list anyway or the sidebar would keep describing the old shape. Re-reading
  // it is the update.
  function onSaved() {
    void refresh();
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          What the engine knows about {client.name}.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <EditableText
          brandSlug={client.slug}
          title="Description"
          help="What this brand is, what it sells, and who it sells to. Every writer run reads it."
          value={client.description}
          emptyText="No description yet. Draft one from the live site, then edit it before saving."
          describable
          onSaved={onSaved}
        />

        {/* The hosted build shows what the engine knows and changes none of it: PATCH is an
            engine write, and the danger zone describes the engine host's own disk, which
            does not exist behind this deployment. */}
        {HOSTED_READONLY ? (
          <ReadOnlyIdentity client={client} orgName={orgName} />
        ) : (
          <>
            {/* Keyed on the saved values: a save re-mounts the form so its drafts reset to what
                the engine now holds. That is React's own answer to resetting state on a prop
                change, and it needs no effect to chase the props. */}
            <IdentityCard
              key={`${client.slug}:${client.domain}:${client.industry}:${orgName}`}
              client={client}
              orgName={orgName}
              onSaved={onSaved}
            />
            <DangerZone client={client} />
          </>
        )}
      </div>
    </div>
  );
}

/** The identity fields as facts to read, for the hosted build where nothing here saves. */
function ReadOnlyIdentity({ client, orgName }: { client: Client; orgName: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm font-semibold text-foreground">Identity</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The slug <span className="machine">{client.slug}</span> is derived from the name and
          is permanent. This dashboard is read only, so these fields are edited from the
          operator dashboard that runs against the engine.
        </p>
        <dl className="mt-4 space-y-3">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Organisation</dt>
            <dd className="mt-0.5 text-sm text-foreground">{orgName}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Domain</dt>
            <dd className="machine mt-0.5 text-sm text-foreground">
              {client.domain || "(not recorded)"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Industry</dt>
            <dd className="mt-0.5 text-sm text-foreground">
              {client.industry || "(not selected)"}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Domain, industry and org: the three fields that decide what the engine fetches and reads. */
function IdentityCard({
  client,
  orgName,
  onSaved,
}: {
  client: Client;
  orgName: string;
  onSaved: () => void;
}) {
  const [domain, setDomain] = React.useState(client.domain);
  const [industry, setIndustry] = React.useState(client.industry);
  const [organisation, setOrganisation] = React.useState(orgName);
  const [industries, setIndustries] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    api.industries(controller.signal).then(
      (data) => setIndustries(data.industries),
      () => {
        // The current industry still renders below, so a failed list costs the operator the
        // ability to CHANGE it, not the ability to see it.
      },
    );
    return () => controller.abort();
  }, []);

  const dirty =
    domain !== client.domain || industry !== client.industry || organisation !== orgName;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // PATCH carries only what changed: the engine reads an absent key as "do not write",
      // so sending every field would let a stale value overwrite one changed in another tab.
      await updateClient(client.slug, {
        ...(domain !== client.domain ? { domain: domain.trim() } : {}),
        ...(industry !== client.industry ? { industry } : {}),
        ...(organisation !== orgName ? { organisation_name: organisation.trim() } : {}),
      });
      toast.success("Saved");
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent>
        <p className="text-sm font-semibold text-foreground">Identity</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The slug <span className="machine">{client.slug}</span> is derived from the name and
          is permanent: the engine stores this brand&apos;s facts and output under it.
        </p>

        <form onSubmit={save} className="mt-4 space-y-4">
          <div>
            <Label htmlFor="settings-org">Organisation</Label>
            <OrgCombobox
              id="settings-org"
              value={organisation}
              onChange={setOrganisation}
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              A grouping only. Brands never share canonical facts or a roadmap, whichever
              organisation they sit under.
            </p>
          </div>

          <div>
            <Label htmlFor="settings-domain">Domain</Label>
            <Input
              id="settings-domain"
              type="url"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              autoComplete="off"
              className="mt-1.5"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The live site wins over internal docs on any conflict, so this is what the
              researcher fetches first.
            </p>
          </div>

          <div>
            <Label htmlFor="settings-industry">Industry</Label>
            <select
              id="settings-industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className={cn(
                "mt-1.5 h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              )}
            >
              {/* The saved value may not be in the list if the list failed to load, so it is
                  always an option: a select that silently drops it would rewrite the brand. */}
              {industries.includes(industry) || industry === "" ? null : (
                <option value={industry}>{industry}</option>
              )}
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
          </div>

          {error ? <FieldError error={error} /> : null}

          <Button type="submit" size="sm" disabled={!dirty || saving}>
            {saving ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            Save changes
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Deletion is not exposed, because the engine has no delete endpoint and inventing a button
 * that cannot work would be worse than saying plainly where the files are.
 */
function DangerZone({ client }: { client: Client }) {
  return (
    <Card className="border-fail/25">
      <CardContent>
        <p className="text-sm font-semibold text-fail">Danger zone</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Removing a brand means deleting its directory on the machine running the engine.
          There is no button for it here: the engine exposes no delete, and the directory
          holds the only copy of this brand&apos;s canonical facts and every blog written for
          it.
        </p>
        <pre className="machine mt-3 overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground">
          clients/{client.slug}/
        </pre>
        {client.demo_mode ? (
          <p className="mt-3 text-xs text-muted-foreground">
            This brand is in demo mode, so everything under that path is precoded fake output
            written with zero API calls.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { useOrgs } from "@/lib/orgs-context";
import { BrandRoute } from "@/components/shell/brand-route";
import { ReadOnlyText } from "@/components/clients/editable-text";
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
        {/* Read only, and generated, never typed. The engine drafts this from the brand website
            the moment the brand is added (server/describe.py) and writes it to the record, so
            there is no Edit here and no "Draft with Claude": the description is not the operator's
            to write or change. */}
        <ReadOnlyText
          title="Description"
          help="Generated automatically from the brand website when this brand was added. Every writer run reads it."
          value={client.description}
          emptyText="No description yet. It is generated from the brand website shortly after the brand is added."
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
              key={`${client.slug}:${client.domain}:${orgName}`}
              client={client}
              orgName={orgName}
              onSaved={onSaved}
            />
            {/* Keyed on the saved value so a save resets the draft to what the engine now holds,
                the same trick IdentityCard uses. */}
            <CustomInstructionsCard
              key={`${client.slug}:instructions`}
              client={client}
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
              {client.industry || "(detected from the brand website shortly after the brand is added)"}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

/** Domain and org: the two editable fields that decide what the engine fetches and reads. */
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
  const [organisation, setOrganisation] = React.useState(orgName);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const dirty = domain !== client.domain || organisation !== orgName;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // PATCH carries only what changed: the engine reads an absent key as "do not write",
      // so sending every field would let a stale value overwrite one changed in another tab.
      await updateClient(client.slug, {
        ...(domain !== client.domain ? { domain: domain.trim() } : {}),
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

          {/* Read only, exactly like the description above and for the same reason: the
              describe session detects it from the brand website right after the brand is
              added (server/describe.py), and it picks the industry reference the writer
              loads. It is not the operator's to change, so there is no control here. */}
          <div>
            <p className="text-xs font-medium text-muted-foreground">Industry</p>
            <p className="mt-1.5 text-sm text-foreground">
              {client.industry ||
                "(detected from the brand website shortly after the brand is added)"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Detected automatically from the brand website. It picks the industry reference
              the writer loads.
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
 * The brand's standing blog instructions: what every blog for this brand must follow.
 *
 * These reach the research, writing and evaluation agents as a MAJOR priority, ranked above the
 * house style defaults and the roadmap guidance but never above the brand's canonical facts, so
 * this is the place to say things like "always cite an India-specific source" or "never open with
 * a question". It is a per-run instruction's durable sibling: session instructions typed at
 * Generate apply to one run, these apply to every blog until changed here. Empty is a legitimate
 * state and clears them.
 */
function CustomInstructionsCard({
  client,
  onSaved,
}: {
  client: Client;
  onSaved: () => void;
}) {
  const [value, setValue] = React.useState(client.custom_instructions ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const dirty = value !== (client.custom_instructions ?? "");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Sent even when blank: "" is the operator clearing their instructions, a real change the
      // engine writes, not a no-op. The PATCH reads absent-as-untouched, so a blank string is
      // the only way to say "remove them".
      await updateClient(client.slug, { custom_instructions: value });
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
        <p className="text-sm font-semibold text-foreground">Custom blog instructions</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Standing instructions every blog for {client.name} must follow. The engine obeys them as
          a major priority, above its house style and the roadmap guidance, but never above this
          brand&apos;s canonical facts, and no instruction here licenses inventing a source or a
          statistic. Leave it empty for none.
        </p>

        <form onSubmit={save} className="mt-4 space-y-4">
          <div>
            <Label htmlFor="settings-instructions" className="sr-only">
              Custom blog instructions
            </Label>
            <Textarea
              id="settings-instructions"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={6}
              placeholder={
                "e.g. Always cite an India-specific source for market data. Address the reader " +
                "as “you”. Never open with a rhetorical question."
              }
              className="min-h-32"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Applies to every blog written from now on. To shape just one run, use the
              instructions box that appears when you press Generate.
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
      </CardContent>
    </Card>
  );
}

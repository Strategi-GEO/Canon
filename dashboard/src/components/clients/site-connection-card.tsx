"use client";

import * as React from "react";
import { Check, ExternalLink, Loader2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import type { SiteConnection, SiteField } from "@/types";

/**
 * WHERE THIS BRAND'S BLOGS PUBLISH, and the credential that gets them there.
 *
 * IT LIVES IN SETTINGS RATHER THAN IN A TAB OF ITS OWN. A brand already carries ten tabs, and
 * this is one card of per-brand configuration sitting beside the others. A tab would be
 * navigation weight bought for one form.
 *
 * THE FIELDS ARE THE ENGINE'S, NOT THIS FILE'S. Every credential input below is rendered from
 * what GET /site/fields returns for the chosen platform, so adding Shopify is a driver file in
 * server/cms/ and touches nothing here. A hardcoded username-and-password form would have made
 * the second platform a dashboard change, which is exactly the coupling the driver contract
 * exists to avoid.
 *
 * DETECTION IS A CONVENIENCE AND NEVER A DECISION. Pressing Detect fetches the page and reads
 * its platform, purely so an operator does not have to know one; it is re-decided by the engine
 * on Connect, which authenticates against the site's own API. An empty answer is ordinary and
 * falls through to the dropdown rather than reading as a failure.
 *
 * NOTHING IS STORED UNTIL THE ENGINE PROVED IT. There is no Save separate from Connect, because
 * a saved-but-unverified credential would put a live Post button in front of an operator that
 * fails on a real article, on a client's real website.
 */
export function SiteConnectionCard({
  slug,
  onSaved,
}: {
  slug: string;
  /** The brand list carries site_kind, and the Post control gates on it, so a change re-reads. */
  onSaved: () => void;
}) {
  const [state, setState] = React.useState<SiteConnection | null>(null);
  const [loadError, setLoadError] = React.useState<ApiError | null>(null);

  // A COUNTER, NOT A CALLBACK, is what a re-read asks for here. An async loader called straight
  // out of an effect sets state inside it, which is the pattern React's own lint rule refuses;
  // bumping a number and letting the effect own every write keeps the fetch where the cleanup
  // is, so a slug change or an unmount cannot land a stale answer on top of a fresh one.
  const [reloads, setReloads] = React.useState(0);
  const reload = React.useCallback(() => setReloads((n) => n + 1), []);

  React.useEffect(() => {
    const controller = new AbortController();
    api.siteConnection(slug, controller.signal).then(
      (settled) => {
        setState(settled);
        setLoadError(null);
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setLoadError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
      },
    );
    return () => controller.abort();
  }, [slug, reloads]);

  return (
    <Card>
      <CardContent>
        <p className="text-sm font-semibold text-foreground">Blog destination</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Where this brand&apos;s finished blogs are published. Until one is set, the Post
          control on every blog stays disabled: there is nowhere for an article to go.
        </p>

        {loadError ? (
          <div className="mt-4">
            <FieldError error={loadError} />
          </div>
        ) : state === null ? (
          <p className="mt-4 text-xs text-muted-foreground">Reading the destination…</p>
        ) : state.configured ? (
          <Connected
            slug={slug}
            state={state}
            onChanged={() => {
              reload();
              onSaved();
            }}
          />
        ) : (
          <Connect
            slug={slug}
            kinds={state.kinds}
            onConnected={() => {
              reload();
              onSaved();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** The settled state: what it is, and the two ways out of it. */
function Connected({
  slug,
  state,
  onChanged,
}: {
  slug: string;
  state: SiteConnection;
  onChanged: () => void;
}) {
  const [changing, setChanging] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const postType = typeof state.fields.post_type_label === "string"
    ? state.fields.post_type_label
    : "";
  const blogUrl = typeof state.fields.blog_url === "string" ? state.fields.blog_url : "";
  // False means the site had nothing published when it was connected, so the post type is the
  // WordPress default rather than one an article proved. Said out loud rather than hidden: the
  // operator can point it somewhere else once the client publishes anything.
  const verified = state.fields.verified !== false;

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      await api.siteDisconnect(slug);
      toast.success("Disconnected");
      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setBusy(false);
    }
  }

  if (changing) {
    return (
      <Connect
        slug={slug}
        kinds={state.kinds}
        onConnected={() => {
          setChanging(false);
          onChanged();
        }}
        onCancel={() => setChanging(false)}
      />
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-ship/25 bg-ship/10 px-2.5 py-1 text-xs font-medium text-ship">
          <Check className="size-3.5" aria-hidden />
          {state.label || state.kind}
        </span>
        {postType ? (
          <span className="text-xs text-muted-foreground">
            Blogs publish as <span className="machine">{postType}</span>
          </span>
        ) : null}
      </div>

      {blogUrl ? (
        <p className="text-xs text-muted-foreground">
          Matched against{" "}
          <a
            href={blogUrl}
            target="_blank"
            rel="noreferrer"
            className="underline decoration-primary/40 underline-offset-2 hover:text-primary"
          >
            {blogUrl}
          </a>
        </p>
      ) : null}

      {!verified ? (
        <p className="text-xs text-muted-foreground">
          Nothing was published on that page when this was connected, so blogs will go to the
          site&apos;s standard Posts. Change it once they have an article live.
        </p>
      ) : null}

      {error ? <FieldError error={error} /> : null}

      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setChanging(true)} disabled={busy}>
          Change
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void disconnect()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                 : <Unplug data-icon="inline-start" aria-hidden />}
          Disconnect
        </Button>
      </div>
    </div>
  );
}

/** URL first, platform second, credentials third. Every step degrades to something manual. */
function Connect({
  slug,
  kinds,
  onConnected,
  onCancel,
}: {
  slug: string;
  kinds: SiteConnection["kinds"];
  onConnected: () => void;
  onCancel?: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [kind, setKind] = React.useState("");
  const [fields, setFields] = React.useState<SiteField[]>([]);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [unsupported, setUnsupported] = React.useState("");
  const [detecting, setDetecting] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  // Choosing a platform by hand asks the engine what it wants, exactly as detection does, so
  // the two paths converge on one shape and the dropdown is never a lesser door.
  const choose = React.useCallback(
    async (next: string) => {
      setKind(next);
      setValues({});
      setUnsupported("");
      if (!next) {
        setFields([]);
        return;
      }
      try {
        setFields((await api.siteFields(slug, next)).fields);
      } catch {
        // The dropdown still works with no help text; a failure here must not strand the form.
        setFields([]);
      }
    },
    [slug],
  );

  async function detect() {
    setDetecting(true);
    setError(null);
    setUnsupported("");
    try {
      const found = await api.siteDetect(slug, url);
      if (found.unsupported) {
        setUnsupported(found.unsupported);
        setKind("");
        setFields([]);
        return;
      }
      if (found.kind) {
        setKind(found.kind);
        setFields(found.fields);
        setValues({});
        return;
      }
      // Could not tell. Not an error: the dropdown is the answer.
      toast.info("Could not tell what that site runs on. Choose the platform below.");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setDetecting(false);
    }
  }

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      await api.siteConnect(slug, kind, url, values);
      toast.success("Connected");
      onConnected();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setConnecting(false);
    }
  }

  // Every destination is a real website with a real credential now, so there is no "needs
  // nothing" case: an address and every field the platform asks for, or the button stays down.
  const ready =
    Boolean(kind) && Boolean(url.trim()) &&
    fields.every((field) => (values[field.key] ?? "").trim().length > 0);

  return (
    <div className="mt-4 space-y-4">
      <div>
        <Label htmlFor="site-url">Their blog page</Label>
        <div className="mt-1.5 flex gap-2">
          <Input
            id="site-url"
            value={url}
            // Deliberately not a plausible domain. `acme` is this repo's example convention in
            // comments and fixtures, and a placeholder is the one place it would be read as a
            // real brand's address rather than as a hint.
            placeholder="https://theirsite.com/blog"
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void detect()}
            disabled={detecting || !url.trim()}
          >
            {detecting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                       : null}
            Detect
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          The page where their articles are listed, or a link to any one article. A link to a
          real article is better: it tells the engine exactly which section of their site the
          blog lives in, so posts land where the existing ones are.
        </p>
      </div>

      {unsupported ? (
        <p className="rounded-md border border-fail/25 bg-fail/5 px-3 py-2 text-xs text-muted-foreground">
          {unsupported}
        </p>
      ) : null}

      <div>
        <Label htmlFor="site-kind">Platform</Label>
        <select
          id="site-kind"
          value={kind}
          onChange={(event) => void choose(event.target.value)}
          className="mt-1.5 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
        >
          <option value="">Choose…</option>
          {kinds.map((entry) => (
            <option key={entry.kind} value={entry.kind}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>

      {/* Rendered from the engine's own answer, so a new platform's fields appear here with no
          change to this file. `secret` drives the input type AND what the engine returns on a
          later read: a field marked secret is never sent back to any browser. */}
      {fields.map((field) => (
        <div key={field.key}>
          <Label htmlFor={`site-${field.key}`}>{field.label}</Label>
          <Input
            id={`site-${field.key}`}
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            value={values[field.key] ?? ""}
            onChange={(event) =>
              setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
            }
            className="mt-1.5"
          />
          {field.help ? (
            <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>
          ) : null}
        </div>
      ))}

      {error ? <FieldError error={error} /> : null}

      <div className="flex gap-2">
        <Button size="sm" onClick={() => void connect()} disabled={!ready || connecting}>
          {connecting ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                      : <ExternalLink data-icon="inline-start" aria-hidden />}
          Connect
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={connecting}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

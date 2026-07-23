"use client";

import * as React from "react";
import { CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import type { AppUpdateCheck } from "@/types";

/**
 * The desktop app's Settings panel: the current version, and a one-click update. Rendered ONLY on
 * the packaged app (the sidebar gates its trigger on !HOSTED_READONLY), because updating "the app"
 * is meaningless on the hosted Vercel dashboard, which has no local app behind it.
 *
 * The update is two-phase by design (see app_update.py): "Update now" DOWNLOADS the small code
 * package and stages it; it APPLIES on the next restart, when no process holds the files. So the
 * success state tells the operator to restart, rather than pretending the swap already happened.
 * The heavy runtimes are never re-downloaded and server/.env is preserved, so keys are never
 * re-entered.
 *
 * State is only ever set from the promise resolution in `load` (never synchronously in the effect,
 * which the react-hooks rule forbids) or from user-event handlers, matching blogs-library. The
 * "checking" indicator is derived: check === null && no error means the first check is in flight.
 */
export function SettingsDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [version, setVersion] = React.useState<string | null>(null);
  const [check, setCheck] = React.useState<AppUpdateCheck | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [staged, setStaged] = React.useState<string | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(
    (signal?: AbortSignal) =>
      Promise.all([api.appVersion(signal), api.checkAppUpdate(signal)]).then(
        ([v, c]) => {
          setVersion(v.version);
          setCheck(c);
          setError(null);
        },
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
        },
      ),
    [],
  );

  // Re-check every time the panel opens, so a release cut while it sat closed still shows.
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  function checkAgain() {
    setStaged(null);
    setError(null);
    setCheck(null);
    void load();
  }

  async function runUpdate() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateApp();
      setStaged(result.staged_version);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setBusy(false);
    }
  }

  const checking = check === null && error === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            The version of Strategi Canon running on this machine, and software updates.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-border px-3.5 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">Strategi Canon</p>
              <p className="text-xs text-muted-foreground">The desktop app on this computer</p>
            </div>
            <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
              {version ? `v${version}` : checking ? "…" : "—"}
            </span>
          </div>

          <div className="space-y-2.5">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Software update
            </p>

            {error ? (
              <FieldError error={error} />
            ) : staged ? (
              /* Downloaded: the app restarts itself to apply it, so the page is about to drop. */
              <div className="flex items-start gap-2.5 rounded-lg border border-border px-3.5 py-3 text-sm">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <p className="text-foreground">
                  Update <span className="font-mono">v{staged}</span> downloaded. Strategi Canon is
                  restarting to apply it, so this page will disconnect and reconnect in a few
                  seconds. Your keys and work are kept.
                </p>
              </div>
            ) : checking ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Checking for updates…
              </p>
            ) : check?.update_available ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3.5 py-3">
                <div>
                  <p className="text-sm text-foreground">
                    Update available:{" "}
                    <span className="font-mono font-medium">v{check.latest}</span>
                  </p>
                  {/* Updating restarts the app, which would kill a live run, so the engine refuses
                      it (409) and the button is disabled until the run finishes. */}
                  {check.runs_active ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      A blog is generating. You can update once it finishes.
                    </p>
                  ) : null}
                </div>
                <Button size="sm" onClick={runUpdate} disabled={busy || check.runs_active}>
                  {busy ? (
                    <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                  ) : (
                    <Download data-icon="inline-start" aria-hidden />
                  )}
                  {busy ? "Downloading…" : "Update now"}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {check?.notes || "You are on the latest version."}
                </p>
                <Button variant="ghost" size="sm" onClick={checkAgain}>
                  <RefreshCw data-icon="inline-start" aria-hidden />
                  Check again
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

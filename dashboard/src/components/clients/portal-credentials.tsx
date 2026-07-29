"use client";

import * as React from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { PortalCredential } from "@/types";

/**
 * The one-time reveal of a freshly minted client portal login.
 *
 * It exists because the password genuinely cannot be shown twice: the auth store never returns
 * it, and the engine's local .env.portal-credentials file is the only durable copy. So this is
 * the admin's single chance to copy it, and the dialog is built to make that hard to miss: it is
 * an AlertDialog with no dismiss and no outside-click close, so the ONLY way out is the
 * acknowledge button, and the caller defers whatever happens next (a redirect to the new brand)
 * until that button is pressed. A plain Dialog the operator could click away from would let a
 * one-time password vanish behind an accidental backdrop click.
 *
 * It renders whenever `credential` is non-null and calls `onDone` when acknowledged; the caller
 * clears the credential in `onDone`, which closes it. Shared by both create dialogs so a login
 * minted from "Add organisation" and one minted from "Add brand" reveal the same way.
 */
export function PortalCredentialsDialog({
  credential,
  brandName,
  onDone,
}: {
  credential: PortalCredential | null;
  brandName: string;
  onDone: () => void;
}) {
  return (
    <AlertDialog open={credential !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 shrink-0 text-primary" aria-hidden />
            Client login for {brandName}
          </AlertDialogTitle>
          <AlertDialogDescription>
            This is the portal login for {brandName}. Copy it now and send it to the client: the
            password is shown this once and cannot be retrieved again.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {credential ? (
          <div className="flex flex-col gap-2">
            <CopyRow label="Email" value={credential.email} />
            <CopyRow label="Password" value={credential.password} mono />
          </div>
        ) : null}

        {/* Not decoration: it is the whole reason the dialog cannot be dismissed by mistake. */}
        <p className="flex items-start gap-2 rounded-lg border border-review/25 bg-review-bg px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-review" aria-hidden />
          <span>
            Save this somewhere safe before you close this. It will not be shown again. If it is
            lost, the login has to be reset from the engine rather than read back.
          </span>
        </p>

        <AlertDialogFooter>
          <AlertDialogAction size="sm" onClick={onDone}>
            I have saved it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One labelled value with a copy button, so neither field has to be selected by hand. */
function CopyRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions). The value is on screen to
      // select by hand, so a failed copy is not an error worth a red banner, just a note.
      toast.error("Could not copy. Select the value and copy it manually.");
    }
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code
          className={cn(
            "min-w-0 flex-1 truncate rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm text-foreground",
            mono && "font-mono",
          )}
        >
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label.toLowerCase()}`}
          className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? (
            <Check className="size-4 text-ship" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}

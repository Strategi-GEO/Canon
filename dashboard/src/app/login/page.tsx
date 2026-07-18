"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Wordmark } from "@/components/shell/sidebar";
import { api, ApiError, request } from "@/lib/api";
import { getSession, setSession, type Session } from "@/lib/session";

/** What POST /api/login answers with. `expires_in` is real but redundant beside expires_at. */
type LoginResponse = Session & { expires_in: number };

/**
 * THE ONE LOGIN for the whole app. Both operators and clients sign in here; the account
 * decides the interface, not a separate door. On success the role routes the caller: an
 * operator to /admin, a client to the site root, which sends them on to their own brand
 * space. There is no sign-up link on purpose: accounts are provisioned by the Strategi team.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Already signed in means nothing to do here: straight to the root, which routes by role.
  React.useEffect(() => {
    if (getSession() !== null) {
      router.replace("/");
    }
  }, [router]);

  // DocumentTitle owns every title INSIDE the shell, and this page is outside it, so the
  // one-owner rule holds: out here this effect is the only writer.
  React.useEffect(() => {
    document.title = "Sign in / Strategi Canon";
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const session = await request<LoginResponse>("/api/login", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: session.user,
      });
      // The credential is real, but WHOSE is it? An operator goes to the admin interface; a
      // client goes to the root, which routes them on to their own brand space. Same app,
      // same session, one hop, no second password and no cross-origin handoff.
      const me = await api.me();
      router.replace(me.is_admin ? "/admin" : "/");
      // Deliberately no setPending(false) on success: the button stays disabled for the
      // moment the redirect takes, instead of flashing back to life on a page that is leaving.
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError("Invalid email or password");
      } else if (cause instanceof ApiError && cause.isOffline) {
        setError("Cannot reach the engine");
      } else {
        setError(cause instanceof ApiError ? cause.message : String(cause));
      }
      setPending(false);
    }
  }

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-background px-4">
      {/* The brand's one accent, used once: a hairline of burnt orange along the top
          edge. Everything else stays on the cool neutral ground, which is what keeps
          the orange reading as identity rather than decoration. */}
      <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />

      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-1.5">
          <Wordmark />
          <p className="text-xs text-muted-foreground">
            Strategi&apos;s GEO content engine for AI search
          </p>
        </div>

        {/* Shadows stay black in both themes; dark needs a heavier one to register against
            the near-black ground, where a 4% shadow simply vanishes. */}
        <Card className="border-border/80 shadow-md shadow-black/5 dark:shadow-black/40">
          <CardHeader className="space-y-1">
            <CardTitle className="text-lg tracking-tight">Welcome back</CardTitle>
            <CardDescription>
              Sign in with the account your administrator provisioned.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@strategi.is"
                  required
                  autoComplete="email"
                  autoFocus
                  aria-invalid={error !== null ? true : undefined}
                  className="h-10"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="login-password">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  aria-invalid={error !== null ? true : undefined}
                  className="h-10"
                />
              </div>

              {error !== null ? (
                <div
                  role="alert"
                  className="rounded-md border border-fail/20 bg-fail-bg px-3 py-2 text-xs font-medium wrap-break-word text-fail"
                >
                  {error}
                </div>
              ) : null}

              <Button type="submit" className="h-10 w-full" disabled={pending}>
                {pending ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                ) : null}
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Strategi internal platform. Access is provisioned, not requested.
        </p>
      </div>
    </div>
  );
}

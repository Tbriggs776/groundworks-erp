"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

/**
 * Sign-in methods beyond email and password, switched on per deployment:
 *   NEXT_PUBLIC_AUTH_PROVIDERS=google,azure   OAuth buttons (enable the
 *                                             providers in Supabase first)
 *   NEXT_PUBLIC_AUTH_SSO=1                    "Sign in with SSO" (SAML,
 *                                             configured per email domain
 *                                             in Supabase)
 */

const LABELS: Record<string, string> = {
  google: "Continue with Google",
  azure: "Continue with Microsoft",
  github: "Continue with GitHub",
};

type Provider = "google" | "azure" | "github";

function enabledProviders(): Provider[] {
  return (process.env.NEXT_PUBLIC_AUTH_PROVIDERS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is Provider => p in LABELS);
}

export function callbackUrl(redirectTo: string): string {
  return `${window.location.origin}/auth/callback?redirectTo=${encodeURIComponent(redirectTo)}`;
}

export function AuthOptions({ redirectTo }: { redirectTo: string }) {
  const providers = enabledProviders();
  const sso = process.env.NEXT_PUBLIC_AUTH_SSO === "1";
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [domain, setDomain] = useState("");

  if (providers.length === 0 && !sso) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      {providers.map((p) => (
        <Button
          key={p}
          type="button"
          variant="outline"
          className="w-full"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const { error } = await createClient().auth.signInWithOAuth({
                provider: p,
                options: { redirectTo: callbackUrl(redirectTo), scopes: p === "azure" ? "email" : undefined },
              });
              if (error) setError(error.message);
            })
          }
        >
          {LABELS[p]}
        </Button>
      ))}
      {sso &&
        (ssoOpen ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const { data, error } = await createClient().auth.signInWithSSO({
                  domain: domain.trim().toLowerCase().replace(/^.*@/, ""),
                  options: { redirectTo: callbackUrl(redirectTo) },
                });
                if (error) setError(error.message);
                else if (data?.url) window.location.href = data.url;
              });
            }}
          >
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="company.com"
              required
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Button type="submit" variant="outline" disabled={pending}>
              Continue
            </Button>
          </form>
        ) : (
          <Button type="button" variant="outline" className="w-full" onClick={() => setSsoOpen(true)}>
            Sign in with SSO
          </Button>
        ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

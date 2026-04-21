"use client";

import { Suspense, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * Wrapping useSearchParams in a Suspense boundary is required by Next.js for
 * the page to render statically. Without it, `next build` fails.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const errorFromQuery = params.get("error");
  const redirectTo = params.get("redirectTo") ?? "/dashboard";

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(errorFromQuery);
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const supabase = createClient();
      const origin = window.location.origin;
      const callback = `${origin}/auth/callback?redirectTo=${encodeURIComponent(
        redirectTo
      )}`;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: callback },
      });
      if (error) setError(error.message);
      else setSent(true);
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-primary grid place-items-center">
              <span className="font-heading text-primary-foreground text-xl">
                G
              </span>
            </div>
            <div className="text-left">
              <div className="font-heading text-xl tracking-[0.2em]">
                GROUNDWORKS
              </div>
              <div className="text-[10px] tracking-[0.3em] text-muted-foreground uppercase">
                Construction ERP
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          {sent ? (
            <div className="text-sm space-y-2">
              <p className="font-medium">Check your email.</p>
              <p className="text-muted-foreground">
                We sent a sign-in link to{" "}
                <span className="text-foreground">{email}</span>.
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder="you@company.com"
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button type="submit" disabled={pending} className="w-full">
                {pending ? "Sending…" : "Send magic link"}
              </Button>
            </form>
          )}
        </div>

        <p className="text-[11px] text-center text-muted-foreground mt-6">
          No password. We email you a sign-in link.
        </p>
      </div>
    </div>
  );
}

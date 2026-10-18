"use client";

import Link from "next/link";
import { Suspense, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { AuthFrame } from "@/components/auth-frame";
import { AuthOptions, callbackUrl } from "@/components/auth-options";
import { safeRedirectPath } from "@/lib/ui/redirect";

/** Why the last session ended, when requireUser ended it. */
const REASONS: Record<string, string> = {
  idle_timeout: "You were signed out after a period of inactivity.",
  max_age: "Your session reached its time limit. Sign in again.",
  revoked: "That session was signed out. Sign in again.",
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const params = useSearchParams();
  const redirectTo = safeRedirectPath(params.get("redirectTo"));
  const notice = REASONS[params.get("reason") ?? ""];

  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error"));
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const { error } = await createClient().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: callbackUrl(redirectTo) },
      });
      if (error) setError(error.message);
      else setSent(true);
    });
  }

  return (
    <AuthFrame
      tagline="Accounting · API · MCP"
      footer={
        <>
          New to Groundworks?{" "}
          <Link href="/signup" className="text-foreground underline underline-offset-2">
            Create an account
          </Link>
        </>
      }
    >
      {sent ? (
        <div className="text-sm space-y-2">
          <p className="font-medium">Check your email.</p>
          <p className="text-muted-foreground">
            We sent a sign-in link to <span className="text-foreground">{email}</span>.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {notice && <p className="rounded-md bg-muted px-3 py-2 text-xs">{notice}</p>}
          <form onSubmit={submit} className="space-y-4">
            <label className="block text-xs uppercase tracking-wider text-muted-foreground">
              Email
              <input
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm normal-case tracking-normal text-foreground outline-none focus:ring-2 focus:ring-ring"
                placeholder="you@company.com"
              />
            </label>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </form>
          <AuthOptions redirectTo={redirectTo} />
        </div>
      )}
    </AuthFrame>
  );
}

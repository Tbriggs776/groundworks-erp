"use client";

import Link from "next/link";
import { Suspense, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { AuthFrame } from "@/components/auth-frame";
import { AuthOptions } from "@/components/auth-options";
import { PasswordInput, authInputClass } from "@/components/password-input";
import { authErrorMessage } from "@/lib/security/password";
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
  const carry = params.get("redirectTo") ? `?redirectTo=${encodeURIComponent(redirectTo)}` : "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("error"));
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const { error } = await createClient().auth.signInWithPassword({ email: email.trim(), password });
      if (error) setError(authErrorMessage(error));
      // A full load, so the server sees the new session cookie.
      else window.location.assign(redirectTo);
    });
  }

  return (
    <AuthFrame
      tagline="Accounting · API · MCP"
      footer={
        <>
          New to Groundworks?{" "}
          <Link href={`/signup${carry}`} className="text-foreground underline underline-offset-2">
            Create an account
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {notice && <p className="rounded-md bg-muted px-3 py-2 text-xs">{notice}</p>}
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-xs uppercase tracking-wider text-muted-foreground">
            Email
            <input
              type="email"
              required
              autoFocus
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`mt-1.5 ${authInputClass}`}
              placeholder="you@company.com"
            />
          </label>
          <PasswordInput label="Password" value={password} onChange={setPassword} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          <Link href="/auth/forgot" className="block text-center text-xs text-muted-foreground hover:text-foreground">
            Forgot your password?
          </Link>
        </form>
        <AuthOptions redirectTo={redirectTo} />
      </div>
    </AuthFrame>
  );
}

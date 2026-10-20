"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { AuthFrame } from "@/components/auth-frame";
import { callbackUrl } from "@/components/auth-options";
import { authInputClass } from "@/components/password-input";
import { authErrorMessage } from "@/lib/security/password";

/**
 * Forgotten password: Supabase emails a one-time link that signs the
 * person in and lands on /auth/reset to choose a new one. Also how someone
 * who signed up before passwords existed sets their first one. The answer
 * is the same whether or not the address has an account.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <AuthFrame
      tagline="Reset password"
      footer={
        <Link href="/auth/login" className="text-foreground underline underline-offset-2">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="text-sm space-y-2">
          <p className="font-medium">Check your email.</p>
          <p className="text-muted-foreground">
            If <span className="text-foreground">{email}</span> has an account, we sent it a link to choose a new
            password. The link works once.
          </p>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const { error } = await createClient().auth.resetPasswordForEmail(email.trim(), {
                redirectTo: callbackUrl("/auth/reset"),
              });
              if (error) setError(authErrorMessage(error));
              else setSent(true);
            });
          }}
        >
          <label className="block text-xs uppercase tracking-wider text-muted-foreground">
            Email
            <input
              type="email"
              required
              autoFocus
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className={`mt-1.5 ${authInputClass}`}
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Sending…" : "Email me a reset link"}
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

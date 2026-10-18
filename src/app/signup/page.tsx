"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { AuthFrame } from "@/components/auth-frame";
import { AuthOptions, callbackUrl } from "@/components/auth-options";

const field =
  "mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm normal-case tracking-normal text-foreground outline-none focus:ring-2 focus:ring-ring";

/**
 * Sign-up: name, work email, company. No password: we email a link, and
 * the link lands on onboarding with the company name filled in.
 */
export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const next = `/onboarding${company.trim() ? `?company=${encodeURIComponent(company.trim())}` : ""}`;

  return (
    <AuthFrame
      tagline="Start your books"
      footer={
        <>
          Already have an account?{" "}
          <Link href="/auth/login" className="text-foreground underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      {sent ? (
        <div className="text-sm space-y-2">
          <p className="font-medium">Check your email.</p>
          <p className="text-muted-foreground">
            We sent a link to <span className="text-foreground">{email}</span>. Open it to finish setting up{" "}
            {company || "your company"}.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              start(async () => {
                const { error } = await createClient().auth.signInWithOtp({
                  email,
                  options: { emailRedirectTo: callbackUrl(next), data: { full_name: name.trim() } },
                });
                if (error) setError(error.message);
                else setSent(true);
              });
            }}
          >
            <label className="block text-xs uppercase tracking-wider text-muted-foreground">
              Your name
              <input required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={field} />
            </label>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground">
              Work email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className={field}
              />
            </label>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground">
              Company name
              <input
                required
                autoComplete="organization"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Acme Landscaping LLC"
                className={field}
              />
            </label>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Sending…" : "Create account"}
            </Button>
          </form>
          <AuthOptions redirectTo={next} />
          <p className="text-[11px] text-muted-foreground">
            You can add more companies and invite your team once you&apos;re in.
          </p>
        </div>
      )}
    </AuthFrame>
  );
}

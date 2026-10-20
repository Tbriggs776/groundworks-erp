"use client";

import Link from "next/link";
import { Suspense, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { AuthFrame } from "@/components/auth-frame";
import { AuthOptions, callbackUrl } from "@/components/auth-options";
import { PasswordInput, authInputClass } from "@/components/password-input";
import { authErrorMessage, newPasswordSchema } from "@/lib/security/password";
import { safeRedirectPath } from "@/lib/ui/redirect";

const field = `mt-1.5 ${authInputClass}`;

/**
 * Sign-up: name, email, password, and company. With email confirmation
 * off in Supabase (Authentication → Providers → Email), the account is
 * signed in at once and lands on onboarding with the company filled in.
 * Arriving from an invitation (`?redirectTo=/invite/…`), there's no
 * company to name: it goes straight back to the invitation.
 */
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const params = useSearchParams();
  const invited = safeRedirectPath(params.get("redirectTo"));
  const joining = invited.startsWith("/invite/");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState("");
  const [confirmSent, setConfirmSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const next = joining
    ? invited
    : `/onboarding${company.trim() ? `?company=${encodeURIComponent(company.trim())}` : ""}`;
  const loginHref = `/auth/login${joining ? `?redirectTo=${encodeURIComponent(invited)}` : ""}`;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const pw = newPasswordSchema.safeParse(password);
    if (!pw.success) return setError(pw.error.issues[0].message);
    start(async () => {
      const { data, error } = await createClient().auth.signUp({
        email: email.trim(),
        password: pw.data,
        options: { emailRedirectTo: callbackUrl(next), data: { full_name: name.trim() } },
      });
      if (error) return setError(authErrorMessage(error));
      // With confirmation on, Supabase answers an existing address with an
      // empty identity list instead of an error.
      if (data.user && data.user.identities?.length === 0) {
        return setError(authErrorMessage({ message: "", code: "user_already_exists" }));
      }
      if (data.session) window.location.assign(next);
      else setConfirmSent(true);
    });
  }

  return (
    <AuthFrame
      tagline={joining ? "Join your team" : "Start your books"}
      footer={
        <>
          Already have an account?{" "}
          <Link href={loginHref} className="text-foreground underline underline-offset-2">
            Sign in
          </Link>
        </>
      }
    >
      {confirmSent ? (
        <div className="text-sm space-y-2">
          <p className="font-medium">Confirm your email.</p>
          <p className="text-muted-foreground">
            We sent a link to <span className="text-foreground">{email}</span>. Open it once and you&apos;re in.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <form className="space-y-4" onSubmit={submit}>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground">
              Your name
              <input required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={field} />
            </label>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground">
              Email
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className={field}
              />
            </label>
            <PasswordInput label="Password" value={password} onChange={setPassword} isNew />
            {!joining && (
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
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Creating account…" : "Create account"}
            </Button>
          </form>
          <AuthOptions redirectTo={next} />
          {!joining && (
            <p className="text-[11px] text-muted-foreground">
              You can add more companies and invite your team once you&apos;re in.
            </p>
          )}
        </div>
      )}
    </AuthFrame>
  );
}

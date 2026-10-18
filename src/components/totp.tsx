"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

/**
 * Authenticator-app (TOTP) steps, talking to Supabase Auth from the
 * browser. Verifying upgrades the session to aal2 and rewrites the auth
 * cookies, so the next server request sees MFA in the JWT.
 */

const inputCls =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-center font-mono text-lg tracking-[0.4em] outline-none focus:ring-2 focus:ring-ring";

function CodeForm({
  onSubmit,
  label,
  pending,
  error,
}: {
  onSubmit: (code: string) => void;
  label: string;
  pending: boolean;
  error: string | null;
}) {
  const [code, setCode] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(code);
      }}
    >
      <label className="block text-xs uppercase tracking-wider text-muted-foreground">
        6-digit code
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          className={`${inputCls} mt-1.5`}
        />
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending || code.length !== 6}>
        {pending ? "Checking…" : label}
      </Button>
    </form>
  );
}

/** Enter a code from an already enrolled factor. */
export function TotpVerify({ factorId, onVerified }: { factorId: string; onVerified: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-sm">Enter the code from your authenticator app.</p>
      <CodeForm
        label="Verify"
        pending={pending}
        error={error}
        onSubmit={(code) =>
          start(async () => {
            setError(null);
            const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId, code });
            if (error) setError(error.message);
            else onVerified();
          })
        }
      />
    </div>
  );
}

/** Enroll a new authenticator app: QR code, secret, then a confirming code. */
export function TotpEnroll({ onEnrolled }: { onEnrolled: () => void }) {
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const auth = createClient().auth;
      // Abandoned enrollments leave unverified factors behind; clear them.
      const { data: existing } = await auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.status === "unverified") await auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await auth.mfa.enroll({
        factorType: "totp",
        friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
      });
      if (cancelled) return;
      if (error || !data) setError(error?.message ?? "Couldn't start setup.");
      else setFactor({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error && !factor) return <p className="text-xs text-destructive">{error}</p>;
  if (!factor) return <p className="text-sm text-muted-foreground">Preparing setup…</p>;

  return (
    <div className="space-y-4">
      <ol className="text-sm space-y-1 list-decimal list-inside text-muted-foreground">
        <li>Open an authenticator app (1Password, Google Authenticator, Authy…).</li>
        <li>Scan this code, or enter the key by hand.</li>
        <li>Type the 6-digit code it shows.</li>
      </ol>
      <div className="flex justify-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL from Supabase */}
        <img src={factor.qr} alt="Authenticator QR code" width={176} height={176} className="rounded-md bg-white p-2" />
      </div>
      <p className="text-center font-mono text-xs break-all text-muted-foreground select-all">{factor.secret}</p>
      <CodeForm
        label="Turn on two-step verification"
        pending={pending}
        error={error}
        onSubmit={(code) =>
          start(async () => {
            setError(null);
            const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId: factor.id, code });
            if (error) setError(error.message);
            else onEnrolled();
          })
        }
      />
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TotpEnroll, TotpVerify } from "@/components/totp";
import { createClient } from "@/lib/supabase/client";

/** Chooses between verifying an existing factor and enrolling a first one. */
export function MfaStep({ redirectTo }: { redirectTo: string }) {
  const router = useRouter();
  const [factorId, setFactorId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    createClient()
      .auth.mfa.listFactors()
      .then(({ data }) => setFactorId(data?.totp[0]?.id ?? null))
      .catch(() => setFactorId(null));
  }, []);

  const done = () => {
    router.replace(redirectTo);
    router.refresh();
  };

  if (factorId === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return factorId ? <TotpVerify factorId={factorId} onVerified={done} /> : <TotpEnroll onEnrolled={done} />;
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/password-input";
import { setPassword } from "@/app/(app)/account/security/actions";

/**
 * Choose a new password for the signed-in person. With `next`, goes there
 * once saved (the reset link); without, stays and confirms (My security).
 */
export function NewPasswordForm({ submitLabel, next }: { submitLabel: string; next?: string }) {
  const router = useRouter();
  const [password, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        setSaved(false);
        start(async () => {
          const r = await setPassword(password);
          if (!r.ok) return setErr(r.error);
          setValue("");
          if (next) window.location.assign(next);
          else {
            setSaved(true);
            router.refresh();
          }
        });
      }}
    >
      <PasswordInput label="New password" value={password} onChange={setValue} isNew autoFocus={Boolean(next)} />
      {err && <p className="text-xs text-destructive">{err}</p>}
      {saved && <p className="text-xs text-[var(--gw-green-bright)]">Password saved. Every other session was signed out.</p>}
      <Button type="submit" disabled={pending} className={next ? "w-full" : undefined}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}

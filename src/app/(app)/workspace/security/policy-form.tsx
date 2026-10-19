"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SecurityPolicy } from "@/lib/workspace/service";
import { savePolicy } from "./actions";

const label = "block text-xs uppercase tracking-wider text-muted-foreground";
const hint = "text-[11px] text-muted-foreground mt-1";

export function PolicyForm({ policy, editable }: { policy: SecurityPolicy; editable: boolean }) {
  const router = useRouter();
  const [requireMfa, setRequireMfa] = useState(policy.requireMfa);
  const [idle, setIdle] = useState(String(policy.sessionIdleMinutes));
  const [maxHours, setMaxHours] = useState(String(policy.sessionMaxHours));
  const [keyDays, setKeyDays] = useState(policy.apiKeyMaxDays ? String(policy.apiKeyMaxDays) : "");
  const [domains, setDomains] = useState(policy.allowedEmailDomains.join(", "));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const r = await savePolicy({
            requireMfa,
            sessionIdleMinutes: Number(idle),
            sessionMaxHours: Number(maxHours),
            apiKeyMaxDays: keyDays.trim() ? Number(keyDays) : null,
            allowedEmailDomains: domains.split(/[\s,]+/).filter(Boolean),
          });
          setMsg(r.ok ? { ok: true, text: "Saved. Changes apply on each person's next request." } : { ok: false, text: r.error });
          if (r.ok) router.refresh();
        });
      }}
    >
      <fieldset disabled={!editable || pending} className="space-y-6">
        <label className="flex items-start gap-3 rounded-md border border-border p-4 cursor-pointer">
          <input type="checkbox" checked={requireMfa} onChange={(e) => setRequireMfa(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--gw-gold)]" />
          <span>
            <span className="block text-sm font-medium">Require two-step verification</span>
            <span className={hint}>
              Everyone must use an authenticator app code when they sign in. Anyone without one (you included) is
              asked to set it up on their next click.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label} htmlFor="idle">Sign out after inactivity (minutes)</label>
            <Input id="idle" type="number" min={5} max={1440} value={idle} onChange={(e) => setIdle(e.target.value)} className="mt-1.5" />
            <p className={hint}>5 to 1440. Typing and clicking count as activity.</p>
          </div>
          <div>
            <label className={label} htmlFor="max">Maximum session length (hours)</label>
            <Input id="max" type="number" min={1} max={720} value={maxHours} onChange={(e) => setMaxHours(e.target.value)} className="mt-1.5" />
            <p className={hint}>Sign in again after this long, even if active.</p>
          </div>
          <div>
            <label className={label} htmlFor="keys">API key lifetime limit (days)</label>
            <Input id="keys" type="number" min={1} max={3650} value={keyDays} onChange={(e) => setKeyDays(e.target.value)} placeholder="No limit" className="mt-1.5" />
            <p className={hint}>New keys must expire within this many days. 90 is a common rotation period.</p>
          </div>
          <div>
            <label className={label} htmlFor="domains">Allowed email domains</label>
            <Input id="domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="Any domain" className="mt-1.5" />
            <p className={hint}>Only invite addresses at these domains, e.g. acme.com, acme.co.uk.</p>
          </div>
        </div>
      </fieldset>

      {editable && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save policy"}</Button>
          {msg && <span className={`text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</span>}
        </div>
      )}
      {!editable && <p className="text-xs text-muted-foreground">Only workspace admins can change these.</p>}
    </form>
  );
}

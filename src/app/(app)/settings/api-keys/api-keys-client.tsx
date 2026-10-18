"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { KeyReveal } from "@/components/key-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Scope } from "@/lib/actor";
import type { PersonalKeyRow } from "@/lib/agents/service";
import { createKey, revokeKey } from "../agents/actions";

const SCOPE_INFO: Record<Scope, string> = {
  read: "Read lists, documents, and reports",
  write: "Create and edit drafts, customers, vendors, items",
  post: "Post to the ledger (invoices, bills, payments, journals)",
  admin: "Manage team, agents, keys, and settings",
};

export function ApiKeysClient({
  mine,
  everyone,
  allowedScopes,
  origin,
  maxDays,
}: {
  mine: PersonalKeyRow[];
  everyone: Array<PersonalKeyRow & { userEmail: string }>;
  allowedScopes: Scope[];
  origin: string;
  /** Workspace limit on key lifetime; null = none. */
  maxDays: number | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const lifetimes = [30, 90, 365].filter((d) => !maxDays || d <= maxDays);
  if (maxDays && !lifetimes.includes(maxDays)) lifetimes.push(maxDays);
  const [expires, setExpires] = useState(String(lifetimes.includes(90) ? 90 : lifetimes[lifetimes.length - 1]));

  function run<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, after?: (r: T) => void) {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.(r);
        router.refresh();
      }
    });
  }

  const table = (rows: Array<PersonalKeyRow & { userEmail?: string }>, showOwner: boolean) => (
    <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium px-3 py-2">Key</th>
            {showOwner && <th className="text-left font-medium px-3 py-2">Person</th>}
            <th className="text-left font-medium px-3 py-2 w-40">Scopes</th>
            <th className="text-left font-medium px-3 py-2 w-32">Expires</th>
            <th className="text-left font-medium px-3 py-2 w-40">Last used</th>
            <th className="w-24"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">No keys.</td>
            </tr>
          )}
          {rows.map((k) => (
            <tr key={k.id} className="border-t border-border">
              <td className="px-3 py-2">
                <div>{k.name}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{k.prefix}…</div>
              </td>
              {showOwner && <td className="px-3 py-2 text-xs">{k.userEmail}</td>}
              <td className="px-3 py-2 text-xs">{k.scopes.join(", ")}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never"}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
              </td>
              <td className="px-3 py-2 text-right">
                {k.revokedAt ? (
                  <Badge variant="outline" className="text-[9px]">Revoked</Badge>
                ) : (
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revokeKey(k.id))}>
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-8 max-w-4xl">
      <section className="space-y-4">
        <p className="text-xs text-muted-foreground max-w-2xl">
          A personal key lets tools act <em>as you</em>: Claude Code on your laptop, a script, a spreadsheet.
          For an always-on assistant, create an <Link href="/settings/agents" className="text-primary hover:underline">agent</Link>{" "}
          instead so its work is labelled and can be held for review.
        </p>
        {token && <KeyReveal token={token} origin={origin} />}
        <div className="rounded-md border border-border p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Key name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code on my laptop" />
            </div>
            <div>
              <Label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Expires after</Label>
              <select
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                className="w-full text-sm bg-background border border-border rounded-md px-2 py-2"
              >
                {lifetimes.map((d) => (
                  <option key={d} value={d}>{d === 365 ? "1 year" : `${d} days`}</option>
                ))}
                {!maxDays && <option value="">Never</option>}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {allowedScopes.map((s) => (
              <label key={s} className="flex items-start gap-2 text-xs cursor-pointer">
                <Checkbox
                  checked={scopes.includes(s)}
                  onCheckedChange={(c) =>
                    setScopes((prev) => (c ? [...prev, s] : prev.filter((x) => x !== s)))
                  }
                />
                <span>
                  <span className="font-semibold">{s}</span> — {SCOPE_INFO[s]}
                </span>
              </label>
            ))}
          </div>
          <Button
            disabled={pending || !name.trim() || scopes.length === 0}
            onClick={() =>
              run(
                () =>
                  createKey({
                    name,
                    scopes,
                    expiresInDays: expires ? Number(expires) : undefined,
                  }),
                (r) => {
                  if ("token" in r) setToken(r.token as string);
                  setName("");
                }
              )
            }
          >
            <KeyRound className="h-3.5 w-3.5" />
            Create personal key
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Your keys</div>
        {table(mine, false)}
      </section>

      {everyone.length > 0 && (
        <section className="space-y-3">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Everyone else&apos;s personal keys</div>
          {table(everyone, true)}
        </section>
      )}

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

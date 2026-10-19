"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { KeyReveal } from "@/components/key-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentWithKeys } from "@/lib/agents/service";
import { money } from "@/lib/money";
import { createKey, revokeKey, updateAgent } from "../actions";
import { AgentFields, type AgentFormState } from "../agent-fields";

export function AgentDetail({
  agent,
  canManage,
  origin,
}: {
  agent: AgentWithKeys;
  canManage: boolean;
  origin: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [form, setForm] = useState<AgentFormState>({
    name: agent.name,
    description: agent.description ?? "",
    role: agent.role === "owner" || agent.role === "admin" ? "bookkeeper" : agent.role,
    autonomy: agent.autonomy,
    maxPostAmount: agent.maxPostAmount ? money(agent.maxPostAmount).toFixed(2) : "",
  });

  function run<T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, after?: (r: T) => void) {
    setErr(null);
    setSaved(false);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else {
        after?.(r);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-8 max-w-4xl">
      <section className="space-y-4">
        <AgentFields value={form} onChange={setForm} disabled={!canManage} />
        {canManage && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={pending || !form.name.trim()}
              onClick={() =>
                run(
                  () =>
                    updateAgent({
                      id: agent.id,
                      name: form.name,
                      description: form.description,
                      role: form.role,
                      autonomy: form.autonomy,
                      maxPostAmount: form.autonomy === "post" && form.maxPostAmount ? form.maxPostAmount : null,
                    }),
                  () => setSaved(true)
                )
              }
            >
              Save changes
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => updateAgent({ id: agent.id, isActive: !agent.isActive }))}
            >
              {agent.isActive ? "Deactivate agent" : "Reactivate agent"}
            </Button>
            {saved && <span className="text-xs text-muted-foreground">Saved. Applies to its keys immediately.</span>}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">API keys</div>
        {token && <KeyReveal token={token} origin={origin} />}
        {canManage && agent.isActive && (
          <div className="flex flex-wrap gap-2">
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Key name, e.g. production"
              className="max-w-xs"
            />
            <Button
              variant="outline"
              disabled={pending || !keyName.trim()}
              onClick={() =>
                run(
                  () => createKey({ name: keyName, agentId: agent.id }),
                  (r) => {
                    if ("token" in r) setToken(r.token as string);
                    setKeyName("");
                  }
                )
              }
            >
              <KeyRound className="h-3.5 w-3.5" />
              Create key
            </Button>
          </div>
        )}
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Key</th>
                <th className="text-left font-medium px-3 py-2 w-40">Created</th>
                <th className="text-left font-medium px-3 py-2 w-40">Last used</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {agent.keys.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground">No keys yet.</td>
                </tr>
              )}
              {agent.keys.map((k) => (
                <tr key={k.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="text-sm">{k.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{k.prefix}…</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {k.revokedAt ? (
                      <Badge variant="outline" className="text-[9px]">Revoked</Badge>
                    ) : (
                      canManage && (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revokeKey(k.id))}>
                          Revoke
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {err && <p className="text-sm text-destructive">{err}</p>}
    </div>
  );
}

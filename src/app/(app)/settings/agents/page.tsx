import Link from "next/link";
import { Bot } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { AutonomyBadge } from "@/components/autonomy";
import { Badge } from "@/components/ui/badge";
import { hasRole, runAs } from "@/lib/actor";
import { listAgents } from "@/lib/agents/service";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { NewAgentButton } from "./new-agent";

export default async function AgentsPage() {
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const agents = await runAs(actor, (ctx) => listAgents(ctx));
  const canManage = hasRole(role, "admin");

  return (
    <AppShell title="Agents" crumb={`${organization.name} · Agents & API`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-xs text-muted-foreground max-w-xl">
            An agent is an AI teammate with its own identity, role, and API keys. Everything it does is
            recorded under its name. Its autonomy decides whether its work posts to the books or waits
            for a person in the review queue.
          </p>
          {canManage && <NewAgentButton />}
        </div>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Agent</th>
                <th className="text-left font-medium px-3 py-2 w-28">Role</th>
                <th className="text-left font-medium px-3 py-2 w-36">Autonomy</th>
                <th className="text-right font-medium px-3 py-2 w-32">Posting limit</th>
                <th className="text-right font-medium px-3 py-2 w-20">Keys</th>
                <th className="text-left font-medium px-3 py-2 w-40">Last active</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-xs text-muted-foreground">
                    No agents yet. Create one, give it a key, and connect it from Claude, Cursor, or any MCP client.
                  </td>
                </tr>
              )}
              {agents.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link href={`/settings/agents/${a.id}`} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                      <Bot className="h-3.5 w-3.5" />
                      {a.name}
                    </Link>
                    {!a.isActive && <Badge variant="outline" className="ml-2 text-[9px]">Deactivated</Badge>}
                    {a.description && <div className="text-[11px] text-muted-foreground">{a.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs capitalize">{a.role}</td>
                  <td className="px-3 py-2"><AutonomyBadge autonomy={a.autonomy} /></td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {a.autonomy !== "post" ? "—" : a.maxPostAmount ? formatMoney(a.maxPostAmount) : "No limit"}
                  </td>
                  <td className="px-3 py-2 text-right text-xs">{a.keys.filter((k) => !k.revokedAt).length}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleString() : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

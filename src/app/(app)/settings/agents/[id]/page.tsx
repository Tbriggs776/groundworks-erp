import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { AutonomyBadge } from "@/components/autonomy";
import { hasRole, runAs } from "@/lib/actor";
import { listAgents } from "@/lib/agents/service";
import { listActivity } from "@/lib/audit-query";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { appOrigin } from "@/lib/ui/origin";
import { AgentDetail } from "./agent-detail";

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const [agents, origin] = await Promise.all([runAs(actor, (ctx) => listAgents(ctx)), appOrigin()]);
  const agent = agents.find((a) => a.id === id);
  if (!agent) notFound();
  const activity = await runAs(actor, (ctx) => listActivity(ctx, { agentId: agent.id, limit: 25 }));

  return (
    <AppShell title={agent.name} crumb={`${organization.name} · Agents`} userEmail={user?.email}>
      <div className="space-y-8">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <AutonomyBadge autonomy={agent.autonomy} />
          <span className="capitalize">{agent.role}</span>
          <span>·</span>
          <span>Last active {agent.lastActiveAt ? new Date(agent.lastActiveAt).toLocaleString() : "never"}</span>
          <Link href="/settings/agents" className="ml-auto hover:text-foreground">← All agents</Link>
        </div>

        <AgentDetail agent={agent} canManage={hasRole(role, "admin")} origin={origin} />

        <section className="space-y-3 max-w-4xl">
          <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Recent activity</div>
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {activity.data.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing yet.</td>
                  </tr>
                )}
                {activity.data.map((a) => (
                  <tr key={a.id} className="border-t border-border first:border-t-0">
                    <td className="px-3 py-2 text-xs text-muted-foreground w-44">{new Date(a.occurredAt).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-xs">{a.event}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground uppercase w-16">{a.channel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link href={`/activity?agentId=${agent.id}`} className="text-xs text-primary hover:underline">
            Full activity log →
          </Link>
        </section>
      </div>
    </AppShell>
  );
}

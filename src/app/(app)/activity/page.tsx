import Link from "next/link";
import { Bot, Cog, User } from "lucide-react";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { listActivity } from "@/lib/audit-query";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { cn } from "@/lib/utils";

const PAGE = 100;

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ agentId?: string; agents?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const agentsOnly = sp.agents === "1";
  const result = await runAs(actor, (ctx) =>
    listActivity(ctx, {
      agentId: sp.agentId || undefined,
      agentsOnly,
      limit: PAGE,
      offset: page * PAGE,
    })
  );

  const tab = (label: string, href: string, active: boolean) => (
    <Link
      href={href}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs",
        active ? "bg-primary/15 text-primary font-semibold" : "text-muted-foreground hover:bg-accent"
      )}
    >
      {label}
    </Link>
  );

  return (
    <AppShell title="Activity" crumb={`${organization.name} · Agents & API`} userEmail={user?.email}>
      <div className="space-y-4 max-w-6xl">
        <div className="flex flex-wrap gap-1">
          {tab("Everything", "/activity", !agentsOnly && !sp.agentId)}
          {tab("Agents only", "/activity?agents=1", agentsOnly)}
        </div>
        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-44">When</th>
                <th className="text-left font-medium px-3 py-2 w-56">Who</th>
                <th className="text-left font-medium px-3 py-2">What</th>
                <th className="text-left font-medium px-3 py-2 w-16">Via</th>
              </tr>
            </thead>
            <tbody>
              {result.data.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-10 text-center text-xs text-muted-foreground">No activity.</td>
                </tr>
              )}
              {result.data.map((a) => {
                const Icon = a.actorType === "agent" ? Bot : a.actorType === "system" || !a.userEmail ? Cog : User;
                const who = a.agentName ?? a.userEmail ?? "System";
                const meta = a.metadata as Record<string, unknown>;
                const ref =
                  (meta.invoiceNumber ?? meta.billNumber ?? meta.paymentNumber ?? meta.journalNumber ?? meta.name ?? meta.email ?? meta.code) as
                    | string
                    | undefined;
                return (
                  <tr key={a.id} className="border-t border-border">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(a.occurredAt).toLocaleString()}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon className={cn("h-3.5 w-3.5", a.actorType === "agent" && "text-primary")} />
                        {a.agentId ? (
                          <Link href={`/settings/agents/${a.agentId}`} className="hover:underline">{who}</Link>
                        ) : (
                          who
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className="font-mono">{a.event}</span>
                      {ref && <span className="text-muted-foreground"> · {ref}</span>}
                    </td>
                    <td className="px-3 py-2 text-[10px] uppercase text-muted-foreground">{a.channel ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex gap-3 text-xs">
          {page > 0 && (
            <Link href={`/activity?${new URLSearchParams({ ...(agentsOnly ? { agents: "1" } : {}), ...(sp.agentId ? { agentId: sp.agentId } : {}), page: String(page - 1) })}`} className="text-primary hover:underline">
              ← Newer
            </Link>
          )}
          {result.hasMore && (
            <Link href={`/activity?${new URLSearchParams({ ...(agentsOnly ? { agents: "1" } : {}), ...(sp.agentId ? { agentId: sp.agentId } : {}), page: String(page + 1) })}`} className="text-primary hover:underline">
              Older →
            </Link>
          )}
        </div>
      </div>
    </AppShell>
  );
}

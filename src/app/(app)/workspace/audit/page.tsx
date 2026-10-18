import { AppShell } from "@/components/app-shell/shell";
import { buttonVariants } from "@/components/ui/button";
import { runAsWorkspace } from "@/lib/actor";
import { getUser, requireWorkspace, requireWorkspaceActor } from "@/lib/auth";
import * as ws from "@/lib/workspace/service";

const FILTERS = [
  { value: "", label: "Everything" },
  { value: "auth.", label: "Sign-ins and sessions" },
  { value: "workspace.", label: "Workspace and policy" },
  { value: "membership.", label: "Company access" },
  { value: "invitation.", label: "Invitations" },
  { value: "agent.", label: "Agents" },
  { value: "api_key.", label: "API keys" },
];

/**
 * The workspace audit log: sign-ins, access changes, policy changes, and
 * every change in every company. Append-only; export for auditors.
 */
export default async function WorkspaceAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; event?: string; company?: string }>;
}) {
  const { workspace } = await requireWorkspace("admin");
  const actor = await requireWorkspaceActor("admin");
  const user = await getUser();
  const sp = await searchParams;
  const query = {
    from: sp.from || undefined,
    to: sp.to || undefined,
    event: sp.event || undefined,
    organizationId: sp.company || undefined,
  };
  const [rows, companies] = await Promise.all([
    runAsWorkspace(actor, (ctx) => ws.listWorkspaceAudit(ctx, { ...query, limit: 200 })),
    runAsWorkspace(actor, (ctx) => ws.listCompanies(ctx)),
  ]);
  const exportHref = `/workspace/audit/export?${new URLSearchParams(
    Object.entries({ from: sp.from, to: sp.to, event: sp.event, company: sp.company }).filter(([, v]) => v) as [string, string][]
  )}`;
  const field = "rounded-md border border-border bg-background px-2 py-1.5 text-xs";

  return (
    <AppShell title="Audit log" crumb={`${workspace.name} · Workspace`} userEmail={user?.email}>
      <div className="space-y-4">
        <form className="flex flex-wrap items-end gap-2" action="/workspace/audit">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">From<input type="date" name="from" defaultValue={sp.from} className={`${field} block mt-1`} /></label>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">To<input type="date" name="to" defaultValue={sp.to} className={`${field} block mt-1`} /></label>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Show
            <select name="event" defaultValue={sp.event ?? ""} className={`${field} block mt-1`}>
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Company
            <select name="company" defaultValue={sp.company ?? ""} className={`${field} block mt-1`}>
              <option value="">All</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <button type="submit" className={buttonVariants({ size: "sm", variant: "outline" })}>Filter</button>
          {/* A plain download link: a prefetching <Link> would run (and audit) the export in the background. */}
          <a href={exportHref} download className={buttonVariants({ size: "sm", className: "ml-auto" })}>Export CSV</a>
        </form>

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2 w-44">When</th>
                <th className="text-left font-medium px-3 py-2">Event</th>
                <th className="text-left font-medium px-3 py-2">Who</th>
                <th className="text-left font-medium px-3 py-2">Company</th>
                <th className="text-left font-medium px-3 py-2">From</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top">
                  <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(r.occurredAt).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.event}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.actorType === "agent" ? `Agent: ${r.agentName ?? "unknown"}` : r.actorEmail ?? (r.actorType === "system" ? "System" : "Unknown")}
                    {r.channel && r.channel !== "ui" && <span className="text-muted-foreground"> · {r.channel}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">{r.company ?? <span className="text-muted-foreground">Workspace</span>}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.ipAddress ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Showing the latest {rows.length} matching events. The export includes up to 10,000 with full detail.
        </p>
      </div>
    </AppShell>
  );
}

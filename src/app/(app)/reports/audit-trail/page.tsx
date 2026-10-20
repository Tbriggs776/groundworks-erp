import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { auditTrail } from "@/lib/reports/detail";
import { ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

const WHO = [
  { value: "", label: "Everyone" },
  { value: "user", label: "People" },
  { value: "agent", label: "Agents" },
  { value: "system", label: "System" },
] as const;

export default async function AuditTrailPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; actorType?: string }> }) {
  const sp = await searchParams;
  const { from, to } = ytd(sp);
  const actorType = WHO.find((w) => w.value && w.value === sp.actorType)?.value as "user" | "agent" | "system" | undefined;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => auditTrail(ctx, { from, to, actorType }));
  return (
    <AppShell title="Audit Trail" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/audit-trail" from={from} to={to}>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Who</div>
              <select name="actorType" defaultValue={actorType ?? ""} className="text-sm bg-background border border-border rounded-md px-2 py-2" aria-label="Who">
                {WHO.map((w) => (
                  <option key={w.value} value={w.value}>{w.label}</option>
                ))}
              </select>
            </div>
          </ReportFilters>
          <ExportLinks report="audit-trail" params={{ from, to, actorType }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} />
      </div>
    </AppShell>
  );
}

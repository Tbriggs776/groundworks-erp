import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { profitAndLossByDimension, reportChoices } from "@/lib/reports/statements";
import { idParam, ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

export default async function ProfitAndLossByClassPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; dimensionId?: string }> }) {
  const sp = await searchParams;
  const { from, to } = ytd(sp);
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const choices = await runAs(actor, (ctx) => reportChoices(ctx));
  const dimensionId = idParam(sp.dimensionId) ?? choices.dimensions[0]?.id;
  const table = await runAs(actor, (ctx) => profitAndLossByDimension(ctx, { from, to, dimensionId }));
  return (
    <AppShell title="P&L by Class" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/profit-and-loss-by-class" from={from} to={to}>
            {choices.dimensions.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Split by</div>
                <select name="dimensionId" defaultValue={dimensionId} className="text-sm bg-background border border-border rounded-md px-2 py-2" aria-label="Split by">
                  {choices.dimensions.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
          </ReportFilters>
          <ExportLinks report="profit-and-loss-by-class" params={{ from, to, dimensionId }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} drill={{ from, to }} />
      </div>
    </AppShell>
  );
}

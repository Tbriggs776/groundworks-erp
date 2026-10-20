import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { profitAndLossByPeriod } from "@/lib/reports/statements";
import { ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

const PERIODS = [
  ["month", "Months"],
  ["quarter", "Quarters"],
  ["year", "Years"],
] as const;

export default async function ProfitAndLossByPeriodPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; period?: string }> }) {
  const sp = await searchParams;
  const { from, to } = ytd(sp);
  const period = PERIODS.some(([p]) => p === sp.period) ? (sp.period as "month") : "month";
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => profitAndLossByPeriod(ctx, { from, to, period }));
  return (
    <AppShell title="P&L by Month" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/profit-and-loss-by-period" from={from} to={to}>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Columns</div>
              <select name="period" defaultValue={period} className="text-sm bg-background border border-border rounded-md px-2 py-2" aria-label="Columns">
                {PERIODS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </ReportFilters>
          <ExportLinks report="profit-and-loss-by-period" params={{ from, to, period }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} drill={{ from, to }} />
      </div>
    </AppShell>
  );
}

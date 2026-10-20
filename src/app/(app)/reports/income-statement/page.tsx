import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { profitAndLossTable } from "@/lib/reports/statements";
import { ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

export default async function IncomeStatementPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = ytd(await searchParams);
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => profitAndLossTable(ctx, { from, to }));
  return (
    <AppShell title="Profit and Loss" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/income-statement" from={from} to={to} />
          <ExportLinks report="profit-and-loss" params={{ from, to }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} drill={{ from, to }} />
      </div>
    </AppShell>
  );
}

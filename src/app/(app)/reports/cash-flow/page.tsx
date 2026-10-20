import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { cashFlow } from "@/lib/reports/statements";
import { ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

export default async function CashFlowPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = ytd(await searchParams);
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => cashFlow(ctx, { from, to }));
  return (
    <AppShell title="Statement of Cash Flows" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/cash-flow" from={from} to={to} />
          <ExportLinks report="cash-flow" params={{ from, to }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} drill={{ from, to }} />
      </div>
    </AppShell>
  );
}

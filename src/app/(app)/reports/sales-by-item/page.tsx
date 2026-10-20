import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { salesByItem } from "@/lib/reports/detail";
import { ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

export default async function SalesByItemPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = ytd(await searchParams);
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => salesByItem(ctx, { from, to }));
  return (
    <AppShell title="Sales by Product/Service" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/sales-by-item" from={from} to={to} />
          <ExportLinks report="sales-by-item" params={{ from, to }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} />
      </div>
    </AppShell>
  );
}

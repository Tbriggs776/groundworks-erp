import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { expensesByVendor } from "@/lib/reports/detail";
import { ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

export default async function ExpensesByVendorPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = ytd(await searchParams);
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => expensesByVendor(ctx, { from, to }));
  return (
    <AppShell title="Expenses by Vendor" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-3xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/expenses-by-vendor" from={from} to={to} />
          <ExportLinks report="expenses-by-vendor" params={{ from, to }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} />
      </div>
    </AppShell>
  );
}

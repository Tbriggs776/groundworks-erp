import { format } from "date-fns";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { inventoryValuation } from "@/lib/inventory/stock";
import { DateFilter } from "../date-filter";
import { dateParam } from "../params";
import { ExportLinks, ReportTableView } from "../report-table";

export default async function InventoryValuationPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const asOf = dateParam((await searchParams).asOf, format(new Date(), "yyyy-MM-dd"));
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => inventoryValuation(ctx, { asOf }));
  return (
    <AppShell title="Inventory Valuation" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <DateFilter paramName="asOf" value={asOf} label="As of" />
          <ExportLinks report="inventory-valuation" params={{ asOf }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} />
      </div>
    </AppShell>
  );
}

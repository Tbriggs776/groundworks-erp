import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { stockStatus } from "@/lib/inventory/stock";
import { ExportLinks, ReportTableView } from "../report-table";

export default async function InventoryStockStatusPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => stockStatus(ctx));
  return (
    <AppShell title="Inventory Stock Status" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-end justify-end gap-3">
          <ExportLinks report="inventory-stock-status" params={{}} />
        </div>
        <ReportTableView table={table} companyName={organization.name} />
      </div>
    </AppShell>
  );
}

import { format } from "date-fns";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { openInvoices } from "@/lib/reports/detail";
import { DateFilter } from "../date-filter";
import { dateParam } from "../params";
import { ExportLinks, ReportTableView } from "../report-table";

export default async function OpenInvoicesPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const asOf = dateParam((await searchParams).asOf, format(new Date(), "yyyy-MM-dd"));
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => openInvoices(ctx, { asOf }));
  return (
    <AppShell title="Open Invoices" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <DateFilter paramName="asOf" value={asOf} label="As of" />
          <ExportLinks report="open-invoices" params={{ asOf }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} />
      </div>
    </AppShell>
  );
}

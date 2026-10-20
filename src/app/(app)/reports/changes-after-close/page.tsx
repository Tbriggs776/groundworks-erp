import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { changesAfterClose } from "@/lib/gl/close";
import { ytd } from "../params";
import { ExportLinks, ReportFilters, ReportTableView } from "../report-table";

export default async function ChangesAfterClosePage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { from, to } = ytd(await searchParams);
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const table = await runAs(actor, (ctx) => changesAfterClose(ctx, { from, to }));
  return (
    <AppShell title="Changes After Close" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <ReportFilters action="/reports/changes-after-close" from={from} to={to} />
          <ExportLinks report="changes-after-close" params={{ from, to }} />
        </div>
        <ReportTableView table={table} companyName={organization.name} />
      </div>
    </AppShell>
  );
}

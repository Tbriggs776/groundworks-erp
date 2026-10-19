import { format } from "date-fns";
import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { apAging } from "@/lib/reports/aging";
import { AgingTable } from "../aging-table";
import { DateFilter } from "../date-filter";

export default async function ApAgingPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const params = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const asOf =
    params.asOf && /^\d{4}-\d{2}-\d{2}$/.test(params.asOf)
      ? params.asOf
      : format(new Date(), "yyyy-MM-dd");
  const report = await runAs(actor, (ctx) => apAging(ctx, { asOf }));

  return (
    <AppShell title="AP Aging" crumb={`${organization.name} · Reports`} userEmail={user?.email}>
      <div className="space-y-5 max-w-6xl">
        <DateFilter paramName="asOf" value={asOf} label="As of" />
        <AgingTable report={report} partyLabel="Vendor" docHref={(id) => `/ap/bills/${id}`} />
      </div>
    </AppShell>
  );
}

import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listVendors } from "@/lib/parties/service";
import { VendorsClient } from "./vendors-client";

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) =>
    listVendors(ctx, { q, includeInactive: true, limit: 200 })
  );

  return (
    <AppShell
      title="Vendors"
      crumb={`${organization.name} · Expenses`}
      userEmail={user?.email}
    >
      <VendorsClient vendors={page.data} truncated={page.hasMore} />
    </AppShell>
  );
}

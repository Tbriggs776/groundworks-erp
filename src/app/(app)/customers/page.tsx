import { AppShell } from "@/components/app-shell/shell";
import { runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { listCustomers } from "@/lib/parties/service";
import { CustomersClient } from "./customers-client";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const page = await runAs(actor, (ctx) =>
    listCustomers(ctx, { q, includeInactive: true, limit: 200 })
  );

  return (
    <AppShell
      title="Customers"
      crumb={`${organization.name} · Sales`}
      userEmail={user?.email}
    >
      <CustomersClient customers={page.data} truncated={page.hasMore} />
    </AppShell>
  );
}

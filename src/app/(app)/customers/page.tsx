import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { customers } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { CustomersClient } from "./customers-client";

export default async function CustomersPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, organization.id),
        isNull(customers.deletedAt)
      )
    )
    .orderBy(asc(customers.code));

  return (
    <AppShell
      title="Customers"
      crumb={`${organization.name} · Billing`}
      userEmail={user?.email}
    >
      <CustomersClient customers={rows} />
    </AppShell>
  );
}

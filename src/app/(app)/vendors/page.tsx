import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { VendorsClient } from "./vendors-client";

export default async function VendorsPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const rows = await db
    .select()
    .from(vendors)
    .where(
      and(
        eq(vendors.organizationId, organization.id),
        isNull(vendors.deletedAt)
      )
    )
    .orderBy(asc(vendors.code));

  return (
    <AppShell
      title="Vendors"
      crumb={`${organization.name} · Procurement`}
      userEmail={user?.email}
    >
      <VendorsClient vendors={rows} />
    </AppShell>
  );
}

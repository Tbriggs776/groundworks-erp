import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { BillForm } from "../bill-form";

export default async function NewBillPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [vendorRows, acctRows] = await Promise.all([
    db
      .select()
      .from(vendors)
      .where(
        and(
          eq(vendors.organizationId, organization.id),
          eq(vendors.isActive, true),
          isNull(vendors.deletedAt)
        )
      )
      .orderBy(asc(vendors.code)),
    db
      .select()
      .from(accounts)
      .where(eq(accounts.organizationId, organization.id))
      .orderBy(asc(accounts.code)),
  ]);

  return (
    <AppShell
      title="New Bill"
      crumb={`${organization.name} · Expenses`}
      userEmail={user?.email}
    >
      <BillForm vendors={vendorRows} accounts={acctRows} />
    </AppShell>
  );
}

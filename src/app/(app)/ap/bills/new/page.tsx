import { and, asc, eq, isNull } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { accounts, costCodes, jobs, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { BillForm } from "../bill-form";

export default async function NewBillPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [vendorRows, acctRows, jobRows, costCodeRows] = await Promise.all([
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
    db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.organizationId, organization.id),
          eq(jobs.isActive, true),
          isNull(jobs.deletedAt)
        )
      )
      .orderBy(asc(jobs.code)),
    db
      .select()
      .from(costCodes)
      .where(
        and(
          eq(costCodes.organizationId, organization.id),
          eq(costCodes.isActive, true),
          isNull(costCodes.deletedAt)
        )
      )
      .orderBy(asc(costCodes.code)),
  ]);

  return (
    <AppShell
      title="New AP Bill"
      crumb={`${organization.name} · Procurement`}
      userEmail={user?.email}
    >
      <BillForm
        vendors={vendorRows}
        accounts={acctRows}
        jobs={jobRows}
        costCodes={costCodeRows}
      />
    </AppShell>
  );
}

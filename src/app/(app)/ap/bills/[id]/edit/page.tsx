import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  apBillLines,
  apBills,
  costCodes,
  jobs,
  vendors,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { BillForm } from "../../bill-form";

export default async function EditBillPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [bill] = await db
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, id), eq(apBills.organizationId, organization.id))
    );
  if (!bill) notFound();
  if (bill.status !== "draft" && bill.status !== "rejected") {
    return (
      <AppShell
        title="Edit not allowed"
        crumb={`${organization.name} · Procurement · AP`}
        userEmail={user?.email}
      >
        <p className="text-sm text-muted-foreground">
          A {bill.status} bill can&apos;t be edited. Void it and re-enter if
          needed.
        </p>
      </AppShell>
    );
  }

  const [lineRows, vendorRows, acctRows, jobRows, costCodeRows] =
    await Promise.all([
      db
        .select()
        .from(apBillLines)
        .where(eq(apBillLines.billId, id))
        .orderBy(asc(apBillLines.lineNumber)),
      db
        .select()
        .from(vendors)
        .where(eq(vendors.organizationId, organization.id))
        .orderBy(asc(vendors.code)),
      db
        .select()
        .from(accounts)
        .where(eq(accounts.organizationId, organization.id))
        .orderBy(asc(accounts.code)),
      db
        .select()
        .from(jobs)
        .where(eq(jobs.organizationId, organization.id))
        .orderBy(asc(jobs.code)),
      db
        .select()
        .from(costCodes)
        .where(eq(costCodes.organizationId, organization.id))
        .orderBy(asc(costCodes.code)),
    ]);

  return (
    <AppShell
      title={`Edit ${bill.billNumber}`}
      crumb={`${organization.name} · Procurement · AP Bills`}
      userEmail={user?.email}
    >
      <BillForm
        vendors={vendorRows}
        accounts={acctRows}
        jobs={jobRows}
        costCodes={costCodeRows}
        initial={bill}
        initialLines={lineRows}
      />
    </AppShell>
  );
}

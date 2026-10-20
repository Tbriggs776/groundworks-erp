import { and, asc, desc, eq, getTableColumns, inArray, isNull, or, sql } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import { billSettledSql } from "@/lib/ap/balances";
import { accounts, apBills, vendors } from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { money } from "@/lib/money";
import { PaymentForm, type OpenBill } from "./payment-form";

export default async function NewPaymentPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  // Open bills: posted or paid, less what payments and vendor credits settled.
  const billRows = await db
    .select({
      ...getTableColumns(apBills),
      openBalance: sql<string>`(${apBills.totalAmount} - ${billSettledSql(sql`"ap_bills"."id"`)})::text`,
    })
    .from(apBills)
    .where(
      and(
        eq(apBills.organizationId, organization.id),
        isNull(apBills.deletedAt),
        inArray(apBills.status, ["posted", "paid"])
      )
    )
    .orderBy(desc(apBills.billDate));

  const openBills: OpenBill[] = billRows
    .map((b) => ({ ...b, openBalance: money(b.openBalance).toFixed(2) }))
    .filter((b) => money(b.openBalance).gt(0));

  const openBillsByVendor: Record<string, OpenBill[]> = {};
  for (const b of openBills) {
    const arr = openBillsByVendor[b.vendorId] ?? [];
    arr.push(b);
    openBillsByVendor[b.vendorId] = arr;
  }

  const [vendorRows, bankRows] = await Promise.all([
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
      .where(
        and(
          eq(accounts.organizationId, organization.id),
          // Bank, cash, or credit card: bills can be paid with a card too.
          or(eq(accounts.isCash, true), eq(accounts.isReconciliation, true)),
          eq(accounts.accountType, "posting"),
          eq(accounts.isActive, true)
        )
      )
      .orderBy(asc(accounts.code)),
  ]);

  // Only show vendors that actually have open bills — no point otherwise.
  const vendorsWithBills = vendorRows.filter(
    (v) => (openBillsByVendor[v.id]?.length ?? 0) > 0
  );

  return (
    <AppShell
      title="New AP Payment"
      crumb={`${organization.name} · Expenses`}
      userEmail={user?.email}
    >
      {vendorsWithBills.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No open bills. Post a bill first, then come back to pay it.
        </p>
      ) : bankRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No bank, cash, or credit card accounts yet. Add one in the Chart of Accounts first.
        </p>
      ) : (
        <PaymentForm
          vendors={vendorsWithBills}
          bankAccounts={bankRows}
          openBillsByVendor={openBillsByVendor}
        />
      )}
    </AppShell>
  );
}

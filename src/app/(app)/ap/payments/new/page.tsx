import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { db } from "@/lib/db/client";
import {
  accounts,
  apBills,
  apPaymentApplications,
  apPayments,
  vendors,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { money } from "@/lib/money";
import { PaymentForm, type OpenBill } from "./payment-form";

export default async function NewPaymentPage() {
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  // Pull open bills: status in ('posted','paid'), not voided, not deleted.
  // We compute open balance by subtracting sum of POSTED payment applications.
  const billRows = await db
    .select()
    .from(apBills)
    .where(
      and(
        eq(apBills.organizationId, organization.id),
        isNull(apBills.deletedAt),
        inArray(apBills.status, ["posted", "paid"])
      )
    )
    .orderBy(desc(apBills.billDate));

  // Aggregate prior applied amounts per bill
  const priorAgg = await db
    .select({
      billId: apPaymentApplications.billId,
      total: sql<string>`COALESCE(SUM(${apPaymentApplications.appliedAmount} + ${apPaymentApplications.discountAmount}), 0)::text`,
    })
    .from(apPaymentApplications)
    .innerJoin(apPayments, eq(apPayments.id, apPaymentApplications.paymentId))
    .where(
      and(
        eq(apPaymentApplications.organizationId, organization.id),
        eq(apPayments.status, "posted")
      )
    )
    .groupBy(apPaymentApplications.billId);
  const priorByBill = new Map(priorAgg.map((r) => [r.billId, r.total]));

  const openBills: OpenBill[] = billRows
    .map((b) => {
      const prior = money(priorByBill.get(b.id) ?? "0");
      const open = money(b.totalAmount).minus(prior);
      return { ...b, openBalance: open.toFixed(2) };
    })
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
          eq(accounts.isCash, true),
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
      crumb={`${organization.name} · Procurement`}
      userEmail={user?.email}
    >
      {vendorsWithBills.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No open bills. Post a bill first, then come back to pay it.
        </p>
      ) : bankRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Cash/Bank accounts available. Flag at least one posting account
          with <code>isCash=true</code> in the Chart of Accounts first.
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

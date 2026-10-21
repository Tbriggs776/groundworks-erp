import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import {
  accounts,
  apBillLines,
  apBills,
  purchaseOrders,
  vendors,
} from "@/lib/db/schema";
import { runAs } from "@/lib/actor";
import { getBill } from "@/lib/ap/bills";
import { creditsOnBill, listVendorCreditsAvailable } from "@/lib/ap/credits";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { formatMoney, money } from "@/lib/money";
import { UseVendorCredit, VendorCreditUses } from "../../credit-panels";
import { BillActions } from "./bill-actions";
import { AttachmentsSection } from "@/components/attachments/attachments-section";

export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [result] = await db
    .select({ bill: apBills, vendor: vendors, poNumber: purchaseOrders.poNumber })
    .from(apBills)
    .innerJoin(vendors, eq(vendors.id, apBills.vendorId))
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, apBills.purchaseOrderId))
    .where(
      and(
        eq(apBills.id, id),
        eq(apBills.organizationId, organization.id)
      )
    );
  if (!result) notFound();

  const lines = await db
    .select({
      line: apBillLines,
      account: accounts,
    })
    .from(apBillLines)
    .innerJoin(accounts, eq(accounts.id, apBillLines.accountId))
    .where(eq(apBillLines.billId, id))
    .orderBy(asc(apBillLines.lineNumber));

  const { bill, vendor, poNumber } = result;
  const actor = await requireActor();
  const live = bill.status === "posted" || bill.status === "paid";
  const [detail, applied, available] = live
    ? await runAs(actor, async (ctx) => [
        await getBill(ctx, { id: bill.id }),
        await creditsOnBill(ctx, bill.id),
        bill.status === "posted" ? await listVendorCreditsAvailable(ctx, { vendorId: bill.vendorId }) : [],
      ] as const)
    : [null, [], []];
  const fmt = (v: string) => formatMoney(v, { currency: bill.currency });

  return (
    <AppShell
      title={`Bill ${bill.billNumber}`}
      crumb={`${organization.name} · Expenses · Bills`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em] text-foreground">
              {bill.billNumber}
            </div>
            <div className="text-sm mt-1">{vendor.name}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-3">
              {bill.vendorInvoiceNumber && (
                <span>
                  Vendor invoice:{" "}
                  <span className="font-mono text-foreground">
                    {bill.vendorInvoiceNumber}
                  </span>
                </span>
              )}
              {poNumber && (
                <>
                  <span>·</span>
                  <span>
                    Bills{" "}
                    <Link href={`/ap/purchase-orders/${bill.purchaseOrderId}`} className="font-mono text-primary hover:underline">
                      {poNumber}
                    </Link>
                  </span>
                </>
              )}
              <span>·</span>
              <span>Billed {bill.billDate}</span>
              <span>·</span>
              <span>Due {bill.dueDate}</span>
              <span>·</span>
              <Badge variant="secondary" className="text-[9px] capitalize">
                {bill.status.replace(/_/g, " ")}
              </Badge>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <BillActions bill={bill} />
            <Link
              href="/ap/bills"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back to list
            </Link>
          </div>
        </div>

        {bill.status === "rejected" && bill.rejectionReason && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider text-destructive font-semibold">
              Rejected
            </span>
            {": "}
            {bill.rejectionReason}
          </div>
        )}

        {bill.status === "voided" && bill.voidReason && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">
              Voided
            </span>
            {": "}
            {bill.voidReason}
            {bill.voidGlJournalId && (
              <>
                {" · reversal "}
                <Link
                  href={`/gl/${bill.voidGlJournalId}`}
                  className="text-primary hover:underline"
                >
                  journal
                </Link>
              </>
            )}
          </div>
        )}

        {bill.glJournalId && (bill.status === "posted" || bill.status === "paid") && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            Posted to GL journal{" "}
            <Link
              href={`/gl/${bill.glJournalId}`}
              className="text-primary hover:underline"
            >
              →
            </Link>
          </div>
        )}

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-12">#</th>
                <th className="text-left font-medium px-3 py-2">Account</th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-36">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ line, account }) => (
                <tr key={line.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {line.lineNumber}
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs text-primary">
                      {account.code}
                    </span>{" "}
                    <span className="text-sm">{account.name}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{line.description}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(line.amount, { currency: bill.currency })}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/30 border-t-2 border-border">
                <td
                  className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                  colSpan={4}
                >
                  Total
                </td>
                <td className="px-3 py-2 text-right font-mono text-sm font-semibold">
                  {formatMoney(money(bill.totalAmount), { currency: bill.currency })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {detail && (
          <div className="flex flex-wrap justify-end gap-6 text-xs">
            <span className="text-muted-foreground">
              Paid and credited <span className="font-mono text-foreground">{fmt(money(bill.totalAmount).minus(money(detail.openBalance)).toFixed(2))}</span>
            </span>
            <span className="text-muted-foreground">
              Balance due <span className="font-mono text-sm font-semibold text-foreground">{fmt(detail.openBalance)}</span>
            </span>
          </div>
        )}
        {detail && bill.status === "posted" && available.length > 0 && money(detail.openBalance).gt(0) && (
          <UseVendorCredit
            billId={bill.id}
            openBalance={detail.openBalance}
            currency={bill.currency}
            credits={available.map((c) => ({ id: c.id, number: c.number, remaining: c.remaining }))}
          />
        )}
        <VendorCreditUses
          uses={applied.map((a) => ({ ...a, billId: bill.id, billNumber: bill.billNumber, vendorRefundId: null, refundNumber: null }))}
          currency={bill.currency}
          show="credit"
        />

        {bill.notes && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-1 font-semibold">
              Notes
            </div>
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {bill.notes}
            </div>
          </div>
        )}
        <AttachmentsSection entityType="bill" entityId={id} />
      </div>
    </AppShell>
  );
}

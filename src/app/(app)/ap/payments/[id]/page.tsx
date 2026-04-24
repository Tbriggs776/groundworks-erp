import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { Badge } from "@/components/ui/badge";
import { db } from "@/lib/db/client";
import {
  accounts,
  apBills,
  apPaymentApplications,
  apPayments,
  vendors,
} from "@/lib/db/schema";
import { getUser, requireCurrentOrg } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { PaymentActions } from "./void-button";

export default async function PaymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();

  const [result] = await db
    .select({
      p: apPayments,
      v: vendors,
      bank: accounts,
    })
    .from(apPayments)
    .innerJoin(vendors, eq(vendors.id, apPayments.vendorId))
    .innerJoin(accounts, eq(accounts.id, apPayments.bankAccountId))
    .where(
      and(
        eq(apPayments.id, id),
        eq(apPayments.organizationId, organization.id)
      )
    );
  if (!result) notFound();

  const apps = await db
    .select({
      app: apPaymentApplications,
      bill: apBills,
    })
    .from(apPaymentApplications)
    .innerJoin(apBills, eq(apBills.id, apPaymentApplications.billId))
    .where(eq(apPaymentApplications.paymentId, id))
    .orderBy(asc(apBills.billDate));

  const { p, v, bank } = result;

  return (
    <AppShell
      title={`Payment ${p.paymentNumber}`}
      crumb={`${organization.name} · Procurement · AP Payments`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {p.paymentNumber}
            </div>
            <div className="text-sm mt-1">{v.name}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-3">
              <span>Paid {p.paymentDate}</span>
              <span>·</span>
              <span className="capitalize">{p.method.replace(/_/g, " ")}</span>
              {p.reference && (
                <>
                  <span>·</span>
                  <span>Ref: <span className="font-mono text-foreground">{p.reference}</span></span>
                </>
              )}
              <span>·</span>
              <span>
                From: <span className="font-mono">{bank.code}</span> {bank.name}
              </span>
              <span>·</span>
              <Badge variant="secondary" className="text-[9px] capitalize">
                {p.status}
              </Badge>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <PaymentActions paymentId={p.id} status={p.status} />
            <Link
              href="/ap/payments"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Back to list
            </Link>
          </div>
        </div>

        {p.status === "voided" && p.voidReason && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">Voided</span>
            {" — "}
            {p.voidReason}
            {p.voidGlJournalId && (
              <>
                {" · reversal "}
                <Link
                  href={`/gl/${p.voidGlJournalId}`}
                  className="text-primary hover:underline"
                >
                  journal
                </Link>
              </>
            )}
          </div>
        )}

        {p.glJournalId && p.status === "posted" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            Posted to GL journal{" "}
            <Link
              href={`/gl/${p.glJournalId}`}
              className="text-primary hover:underline"
            >
              →
            </Link>
          </div>
        )}

        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-28">Bill #</th>
                <th className="text-left font-medium px-3 py-2">Vendor invoice</th>
                <th className="text-right font-medium px-3 py-2 w-32">Bill total</th>
                <th className="text-right font-medium px-3 py-2 w-32">Applied</th>
                <th className="text-right font-medium px-3 py-2 w-32">Discount</th>
              </tr>
            </thead>
            <tbody>
              {apps.map(({ app, bill }) => (
                <tr key={app.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link
                      href={`/ap/bills/${bill.id}`}
                      className="text-primary hover:underline"
                    >
                      {bill.billNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {bill.vendorInvoiceNumber ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                    {formatMoney(bill.totalAmount, { currency: bill.currency })}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(app.appliedAmount, { currency: p.currency })}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {formatMoney(app.discountAmount, { currency: p.currency })}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/30 border-t-2 border-border">
                <td
                  className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground"
                  colSpan={3}
                >
                  Totals — net cash{" "}
                  <span className="text-foreground font-semibold">
                    {formatMoney(p.netAmount, { currency: p.currency })}
                  </span>{" "}
                  out of {formatMoney(p.appliedAmount, { currency: p.currency })} applied
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(p.appliedAmount, { currency: p.currency })}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {formatMoney(p.discountAmount, { currency: p.currency })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {p.memo && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground mb-1 font-semibold">
              Memo
            </div>
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {p.memo}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

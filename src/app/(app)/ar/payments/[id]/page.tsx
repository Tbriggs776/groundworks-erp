import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getCustomerPayment } from "@/lib/ar/payments";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { PaymentActions } from "./payment-actions";

export default async function CustomerPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const p = await runAs(actor, (ctx) => getCustomerPayment(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const [deposit] = await db.select().from(accounts).where(eq(accounts.id, p.depositAccountId));
  const creator = await creatorOf(p);
  const fmt = (v: string) => formatMoney(v, { currency: p.currency });

  return (
    <AppShell title={`Payment ${p.paymentNumber}`} crumb={`${organization.name} · Sales · Payments`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{p.paymentNumber}</div>
            <div className="text-sm mt-1">{p.customerName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>Received {p.paymentDate}</span>
              <span>·</span>
              <span className="uppercase">{p.method.replace(/_/g, " ")}</span>
              {p.reference && (
                <>
                  <span>·</span>
                  <span>Ref <span className="font-mono text-foreground">{p.reference}</span></span>
                </>
              )}
              <StatusBadge status={p.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <PaymentActions payment={p} />
            <Link href="/ar/payments" className="text-xs text-muted-foreground hover:text-foreground">
              ← Back to payments
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Stat label="Amount received" value={fmt(p.amount)} />
          <Stat label="Discounts given" value={fmt(p.discountAmount)} />
          <Stat label="Deposited to" value={deposit ? `${deposit.code} ${deposit.name}` : "—"} />
        </div>

        {p.status === "voided" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">Voided</span>
            {p.voidReason && <>: {p.voidReason}</>}
          </div>
        )}
        {p.glJournalId && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            Posted to the ledger ·{" "}
            <Link href={`/gl/${p.glJournalId}`} className="text-primary hover:underline">view journal</Link>
          </div>
        )}

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Applied to invoice</th>
                <th className="text-right font-medium px-3 py-2 w-32">Payment</th>
                <th className="text-right font-medium px-3 py-2 w-32">Discount</th>
              </tr>
            </thead>
            <tbody>
              {p.applications.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/ar/invoices/${a.invoiceId}`} className="text-primary hover:underline">
                      {a.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(a.amount)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {money(a.discountAmount).gt(0) ? fmt(a.discountAmount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {p.memo && <p className="text-xs text-muted-foreground">Memo: {p.memo}</p>}
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-sm mt-0.5">{value}</div>
    </div>
  );
}

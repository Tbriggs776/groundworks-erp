import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getInvoice } from "@/lib/ar/invoices";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { InvoiceActions } from "./invoice-actions";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const inv = await runAs(actor, (ctx) => getInvoice(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(inv);
  const fmt = (v: string) => formatMoney(v, { currency: inv.currency });
  const paid = money(inv.totalAmount).minus(money(inv.openBalance));
  const overdue = inv.status === "open" && inv.dueDate < format(new Date(), "yyyy-MM-dd");

  return (
    <AppShell
      title={`Invoice ${inv.invoiceNumber}`}
      crumb={`${organization.name} · Sales · Invoices`}
      userEmail={user?.email}
    >
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-3xl tracking-[0.08em] text-foreground">
              {inv.invoiceNumber}
            </div>
            <div className="text-sm mt-1">{inv.customerName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>Dated {inv.invoiceDate}</span>
              <span>·</span>
              <span className={overdue ? "text-destructive" : undefined}>Due {inv.dueDate}</span>
              {inv.poNumber && (
                <>
                  <span>·</span>
                  <span>PO <span className="font-mono text-foreground">{inv.poNumber}</span></span>
                </>
              )}
              <StatusBadge status={overdue ? "overdue" : inv.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <InvoiceActions invoice={inv} />
            <Link href="/ar/invoices" className="text-xs text-muted-foreground hover:text-foreground">
              ← Back to invoices
            </Link>
          </div>
        </div>

        {inv.status === "draft" && inv.createdByAgentId && (
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
            Drafted by an agent and waiting for review. Check the lines, then post it or delete it.
          </div>
        )}

        {inv.status === "voided" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">Voided</span>
            {inv.voidReason && <> — {inv.voidReason}</>}
            {inv.voidGlJournalId && (
              <>
                {" · "}
                <Link href={`/gl/${inv.voidGlJournalId}`} className="text-primary hover:underline">
                  reversal journal
                </Link>
              </>
            )}
          </div>
        )}

        {inv.glJournalId && inv.status !== "voided" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            Posted to the ledger ·{" "}
            <Link href={`/gl/${inv.glJournalId}`} className="text-primary hover:underline">
              view journal
            </Link>
          </div>
        )}

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-10">#</th>
                <th className="text-left font-medium px-3 py-2">Product / service</th>
                <th className="text-right font-medium px-3 py-2 w-20">Qty</th>
                <th className="text-right font-medium px-3 py-2 w-28">Rate</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.lineNumber}</td>
                  <td className="px-3 py-2">
                    {l.itemName && <div className="text-sm">{l.itemName}</div>}
                    {l.description && l.description !== l.itemName && (
                      <div className="text-xs text-muted-foreground">{l.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{money(l.quantity).toString()}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.unitPrice)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/30">
                <td colSpan={4} className="px-3 py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
                <td className="px-3 py-2 text-right font-mono text-sm font-semibold">{fmt(inv.totalAmount)}</td>
              </tr>
              {(inv.status === "open" || inv.status === "paid") && (
                <>
                  <tr>
                    <td colSpan={4} className="px-3 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Paid</td>
                    <td className="px-3 py-1 text-right font-mono text-xs">{fmt(paid.toFixed(4))}</td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="px-3 py-1 pb-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Balance due</td>
                    <td className="px-3 py-1 pb-2 text-right font-mono text-sm font-semibold">{fmt(inv.openBalance)}</td>
                  </tr>
                </>
              )}
            </tfoot>
          </table>
        </div>

        {inv.payments.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Payments</div>
            <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {inv.payments.map((p) => (
                    <tr key={p.paymentId} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link href={`/ar/payments/${p.paymentId}`} className="text-primary hover:underline">
                          {p.paymentNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{p.paymentDate}</td>
                      <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {fmt(p.amount)}
                        {money(p.discountAmount).gt(0) && (
                          <span className="text-muted-foreground"> + {fmt(p.discountAmount)} discount</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(inv.memo || inv.privateNote) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {inv.memo && (
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Message</div>
                {inv.memo}
              </div>
            )}
            {inv.privateNote && (
              <div className="rounded-md border border-border px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Private note</div>
                {inv.privateNote}
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

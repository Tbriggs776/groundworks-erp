import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { listBills } from "@/lib/ap/bills";
import { getVendorCredit } from "@/lib/ap/vendor-credits";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { LedgerNotes } from "../../../ar/doc-view";
import { ApDocActions } from "../../ap-doc-actions";
import { ApplyToBill, VendorCreditUses } from "../../credit-panels";

export default async function VendorCreditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const c = await runAs(actor, (ctx) => getVendorCredit(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(c);
  const fmt = (v: string) => formatMoney(v, { currency: c.currency });
  const live = (c.status === "open" || c.status === "applied") && money(c.remaining).gt(0);
  const openBills = live
    ? (await runAs(actor, (ctx) => listBills(ctx, { vendorId: c.vendorId, status: "posted", limit: 200 }))).data.filter((b) => money(b.openBalance).gt(0))
    : [];

  return (
    <AppShell title={`Vendor Credit ${c.creditNumber}`} crumb={`${organization.name} · Expenses · Vendor Credits`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{c.creditNumber}</div>
            <div className="text-sm mt-1">{c.vendorName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{c.creditDate}</span>
              {c.vendorReference && <span>Vendor ref <span className="font-mono text-foreground">{c.vendorReference}</span></span>}
              <StatusBadge status={c.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <ApDocActions kind="vendor_credit" id={c.id} status={c.status} number={c.creditNumber} />
            <Link href="/ap/vendor-credits" className="text-xs text-muted-foreground hover:text-foreground">← Back to vendor credits</Link>
          </div>
        </div>
        <LedgerNotes status={c.status} glJournalId={c.glJournalId} voidGlJournalId={c.voidGlJournalId} voidReason={c.voidReason} agentDraft={Boolean(c.createdByAgentId)} />

        <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left font-medium px-3 py-2 w-10">#</th>
                <th className="text-left font-medium px-3 py-2">Account</th>
                <th className="text-left font-medium px-3 py-2">Description</th>
                <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.lineNumber}</td>
                  <td className="px-3 py-2 text-xs">{l.accountCode} · {l.accountName}</td>
                  <td className="px-3 py-2 text-xs">{l.description}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-muted/30">
              <tr className="border-t-2 border-border">
                <td colSpan={3} className="px-3 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Total</td>
                <td className="px-3 py-1 text-right font-mono text-sm font-semibold">{fmt(c.totalAmount)}</td>
              </tr>
              {(c.status === "open" || c.status === "applied") && (
                <tr>
                  <td colSpan={3} className="px-3 py-1 text-right text-[10px] uppercase tracking-wider text-muted-foreground">Unused credit</td>
                  <td className="px-3 py-1 text-right font-mono text-sm font-semibold">{fmt(c.remaining)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>

        {openBills.length > 0 && (
          <ApplyToBill
            vendorCreditId={c.id}
            remaining={c.remaining}
            currency={c.currency}
            bills={openBills.map((b) => ({ id: b.id, number: b.vendorInvoiceNumber ? `${b.billNumber} (${b.vendorInvoiceNumber})` : b.billNumber, dueDate: b.dueDate, openBalance: b.openBalance }))}
          />
        )}
        {live && (
          <p className="text-xs text-muted-foreground">
            Getting money back instead?{" "}
            <Link href={`/ap/vendor-refunds/new?vendorId=${c.vendorId}&vendorCreditId=${c.id}`} className="text-primary hover:underline">Record the vendor refund</Link>.
          </p>
        )}
        <VendorCreditUses uses={c.uses} currency={c.currency} show="target" />
        {c.memo && (
          <div className="rounded-md border border-border px-3 py-2 text-xs">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Memo</div>
            {c.memo}
          </div>
        )}
      </div>
    </AppShell>
  );
}

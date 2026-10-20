import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getSalesReceipt } from "@/lib/ar/sales-receipts";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { creatorOf } from "@/lib/ui/creator";
import { DocActions } from "../../doc-actions";
import { DocLines, LedgerNotes, Notes } from "../../doc-view";

export default async function SalesReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const r = await runAs(actor, (ctx) => getSalesReceipt(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(r);

  return (
    <AppShell title={`Sales Receipt ${r.receiptNumber}`} crumb={`${organization.name} · Sales · Sales Receipts`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{r.receiptNumber}</div>
            <div className="text-sm mt-1">{r.customerName ?? "No customer"}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{r.receiptDate}</span>
              <span>·</span>
              <span className="uppercase">{r.method.replace(/_/g, " ")}</span>
              {r.reference && (
                <>
                  <span>·</span>
                  <span>Ref <span className="font-mono text-foreground">{r.reference}</span></span>
                </>
              )}
              <span>·</span>
              <span>Deposited to {r.depositAccountName}</span>
              <StatusBadge status={r.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DocActions kind="sales_receipt" id={r.id} status={r.status} number={r.receiptNumber} />
            <Link href="/ar/sales-receipts" className="text-xs text-muted-foreground hover:text-foreground">← Back to sales receipts</Link>
          </div>
        </div>
        <LedgerNotes status={r.status} glJournalId={r.glJournalId} voidGlJournalId={r.voidGlJournalId} voidReason={r.voidReason} agentDraft={Boolean(r.createdByAgentId)} />
        {r.depositedOn && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            In the bank on{" "}
            <Link href={`/banking/transactions/${r.depositedOn.transactionId}`} className="text-primary hover:underline">deposit {r.depositedOn.txnNumber}</Link>
          </div>
        )}
        <DocLines lines={r.lines} subtotal={r.subtotalAmount} taxLines={r.taxLines} taxExempt={r.taxExempt} total={r.totalAmount} currency={r.currency} />
        <Notes memo={r.memo} privateNote={r.privateNote} />
      </div>
    </AppShell>
  );
}

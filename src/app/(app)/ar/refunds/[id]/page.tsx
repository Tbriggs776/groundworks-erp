import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getRefund } from "@/lib/ar/refunds";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { DocActions } from "../../doc-actions";
import { DocLines, LedgerNotes, Notes } from "../../doc-view";
import { AttachmentsSection } from "@/components/attachments/attachments-section";

export default async function RefundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const r = await runAs(actor, (ctx) => getRefund(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(r);

  return (
    <AppShell title={`Refund ${r.refundNumber}`} crumb={`${organization.name} · Sales · Refunds`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{r.refundNumber}</div>
            <div className="text-sm mt-1">{r.customerName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{r.refundDate}</span>
              <span>·</span>
              <span>{r.kind === "credit" ? "Credit refund" : "Returned items"}</span>
              <span>·</span>
              <span className="uppercase">{r.method.replace(/_/g, " ")}</span>
              {r.reference && (
                <>
                  <span>·</span>
                  <span>#<span className="font-mono text-foreground">{r.reference}</span></span>
                </>
              )}
              <span>·</span>
              <span>From {r.bankAccountName}</span>
              <StatusBadge status={r.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DocActions kind="refund" id={r.id} status={r.status} number={r.refundNumber} />
            <Link href="/ar/refunds" className="text-xs text-muted-foreground hover:text-foreground">← Back to refunds</Link>
          </div>
        </div>
        <LedgerNotes status={r.status} glJournalId={r.glJournalId} voidGlJournalId={r.voidGlJournalId} voidReason={r.voidReason} agentDraft={Boolean(r.createdByAgentId)} />
        {r.kind === "items" ? (
          <DocLines lines={r.lines} subtotal={r.subtotalAmount} taxLines={r.taxLines} taxExempt={r.taxExempt} total={r.totalAmount} currency={r.currency} />
        ) : (
          <div className="rounded-md border border-border px-4 py-3 text-sm">
            Paid out {formatMoney(r.totalAmount, { currency: r.currency })} of the customer&apos;s credit
            {r.status === "draft" ? " (taken when it posts)" : ""}.
          </div>
        )}
        <Notes memo={r.memo} privateNote={r.privateNote} />
        <AttachmentsSection entityType="refund" entityId={id} />
      </div>
    </AppShell>
  );
}

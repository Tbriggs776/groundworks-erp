import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getVendorRefund } from "@/lib/ap/vendor-refunds";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { LedgerNotes } from "../../../ar/doc-view";
import { ApDocActions } from "../../ap-doc-actions";
import { VendorCreditUses } from "../../credit-panels";
import { AttachmentsSection } from "@/components/attachments/attachments-section";

export default async function VendorRefundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const r = await runAs(actor, (ctx) => getVendorRefund(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(r);
  return (
    <AppShell title={`Vendor Refund ${r.refundNumber}`} crumb={`${organization.name} · Expenses · Vendor Refunds`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{r.refundNumber}</div>
            <div className="text-sm mt-1">{r.vendorName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{r.refundDate}</span>
              <span className="capitalize">{r.method.replace(/_/g, " ")}</span>
              {r.reference && <span>Ref <span className="font-mono text-foreground">{r.reference}</span></span>}
              <StatusBadge status={r.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <ApDocActions kind="vendor_refund" id={r.id} status={r.status} number={r.refundNumber} />
            <Link href="/ap/vendor-refunds" className="text-xs text-muted-foreground hover:text-foreground">← Back to vendor refunds</Link>
          </div>
        </div>
        <LedgerNotes status={r.status} glJournalId={r.glJournalId} voidGlJournalId={r.voidGlJournalId} voidReason={r.voidReason} agentDraft={Boolean(r.createdByAgentId)} />
        <div className="rounded-md border border-border px-4 py-3 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Refund received</span>
          <span className="font-mono text-lg font-semibold">{formatMoney(r.amount, { currency: r.currency })}</span>
        </div>
        {r.status === "draft" && (
          <p className="text-xs text-muted-foreground">Posting takes {r.vendorCreditId ? "the chosen credit" : "the vendor's oldest credits first"}.</p>
        )}
        <VendorCreditUses uses={r.credits} currency={r.currency} show="credit" />
        {r.memo && <p className="text-xs text-muted-foreground">{r.memo}</p>}
        <AttachmentsSection entityType="vendor_refund" entityId={id} />
      </div>
    </AppShell>
  );
}

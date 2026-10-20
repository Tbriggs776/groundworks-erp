import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { runAs } from "@/lib/actor";
import { getCreditMemo } from "@/lib/ar/credit-memos";
import { listInvoices } from "@/lib/ar/invoices";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { toAppError } from "@/lib/errors";
import { formatMoney, money } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { CreditUses, ApplyCredit } from "../../credit-panels";
import { DocActions } from "../../doc-actions";
import { DocLines, LedgerNotes, Notes } from "../../doc-view";

export default async function CreditMemoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const m = await runAs(actor, (ctx) => getCreditMemo(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(m);
  const fmt = (v: string) => formatMoney(v, { currency: m.currency });
  const open = m.status === "open" && money(m.remaining).gt(0)
    ? (await runAs(actor, (ctx) => listInvoices(ctx, { customerId: m.customerId, status: "open", limit: 200 }))).data
    : [];

  return (
    <AppShell title={`Credit Memo ${m.memoNumber}`} crumb={`${organization.name} · Sales · Credit Memos`} userEmail={user?.email}>
      <div className="space-y-5 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{m.memoNumber}</div>
            <div className="text-sm mt-1">{m.customerName}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{m.memoDate}</span>
              <StatusBadge status={m.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <DocActions kind="credit_memo" id={m.id} status={m.status} number={m.memoNumber} />
            <Link href="/ar/credit-memos" className="text-xs text-muted-foreground hover:text-foreground">← Back to credit memos</Link>
          </div>
        </div>
        <LedgerNotes status={m.status} glJournalId={m.glJournalId} voidGlJournalId={m.voidGlJournalId} voidReason={m.voidReason} agentDraft={Boolean(m.createdByAgentId)} />
        <DocLines
          lines={m.lines}
          subtotal={m.subtotalAmount}
          taxLines={m.taxLines}
          taxExempt={m.taxExempt}
          total={m.totalAmount}
          currency={m.currency}
          extraRows={m.status === "open" || m.status === "applied" ? [{ label: "Unused credit", value: fmt(m.remaining), strong: true }] : []}
        />
        {open.length > 0 && (
          <ApplyCredit
            source={{ creditMemoId: m.id }}
            remaining={m.remaining}
            currency={m.currency}
            invoices={open.map((i) => ({ id: i.id, number: i.invoiceNumber, dueDate: i.dueDate, openBalance: i.openBalance }))}
          />
        )}
        {m.status === "open" && money(m.remaining).gt(0) && (
          <p className="text-xs text-muted-foreground">
            Or pay it back:{" "}
            <Link href={`/ar/refunds/new?kind=credit&customerId=${m.customerId}&creditMemoId=${m.id}`} className="text-primary hover:underline">refund this credit</Link>.
          </p>
        )}
        <CreditUses uses={m.uses} currency={m.currency} />
        <Notes memo={m.memo} privateNote={m.privateNote} />
      </div>
    </AppShell>
  );
}

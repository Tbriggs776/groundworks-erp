import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell/shell";
import { CreatorChip } from "@/components/creator-chip";
import { StatusBadge } from "@/components/status-badge";
import { hasRole, runAs } from "@/lib/actor";
import { getUser, requireActor, requireCurrentOrg } from "@/lib/auth";
import { getBankTransaction } from "@/lib/banking/transactions";
import { toAppError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { creatorOf } from "@/lib/ui/creator";
import { Stat, TXN_TYPE_LABEL } from "../../ui";
import { CheckControls } from "../../../ap/check-controls";
import { TxnActions } from "./txn-actions";
import { AttachmentsSection } from "@/components/attachments/attachments-section";

export default async function BankTransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { organization, role } = await requireCurrentOrg();
  const user = await getUser();
  const actor = await requireActor();
  const t = await runAs(actor, (ctx) => getBankTransaction(ctx, { id })).catch((e) => {
    const code = toAppError(e).code;
    if (code === "not_found" || code === "invalid_input") notFound();
    throw e;
  });
  const creator = await creatorOf(t);
  const fmt = (v: string) => formatMoney(v, { currency: t.currency });
  const label = TXN_TYPE_LABEL[t.type];

  return (
    <AppShell title={`${label} ${t.txnNumber}`} crumb={`${organization.name} · Banking · Transactions`} userEmail={user?.email}>
      <div className="space-y-5 max-w-4xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-heading text-2xl sm:text-3xl tracking-[0.06em]">{t.txnNumber}</div>
            <div className="text-sm mt-1">{t.payee ?? label}</div>
            <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-3">
              <span>{label}</span>
              <span>·</span>
              <span>{t.txnDate}</span>
              {t.reference && (
                <>
                  <span>·</span>
                  <span>{t.type === "check" ? "Check" : "Ref"} <span className="font-mono text-foreground">{t.reference}</span></span>
                </>
              )}
              <StatusBadge status={t.status} />
              <CreatorChip creator={creator} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <TxnActions txn={{ id: t.id, status: t.status, txnNumber: t.txnNumber }} />
            {t.type === "check" && t.status === "posted" && (
              <CheckControls kind="check" id={t.id} bankAccountId={t.bankAccountId} toPrint={t.toPrint} canEdit={hasRole(role, "bookkeeper")} />
            )}
            <Link href="/banking/transactions" className="text-xs text-muted-foreground hover:text-foreground">
              ← Back to transactions
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Stat label="Amount" value={fmt(t.totalAmount)} />
          <Stat label={t.type === "deposit" ? "Deposited to" : t.type === "transfer" ? "From" : "Paid from"} value={t.bankAccountName} />
          {t.type === "transfer" && <Stat label="To" value={t.transferAccountName ?? "—"} />}
        </div>

        {t.status === "voided" && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="uppercase tracking-wider font-semibold">Voided</span>
            {t.voidReason && <>: {t.voidReason}</>}
          </div>
        )}
        {t.glJournalId && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
            Posted to the ledger ·{" "}
            <Link href={`/gl/${t.glJournalId}`} className="text-primary hover:underline">view journal</Link>
            {t.voidGlJournalId && (
              <>
                {" "}· <Link href={`/gl/${t.voidGlJournalId}`} className="text-primary hover:underline">view reversal</Link>
              </>
            )}
          </div>
        )}

        {t.type !== "transfer" && (
          <div className="gw-table-wrap rounded-md border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-medium px-3 py-2 w-10">#</th>
                  <th className="text-left font-medium px-3 py-2">{t.type === "deposit" ? "From" : "Category"}</th>
                  <th className="text-left font-medium px-3 py-2">Description</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                </tr>
              </thead>
              <tbody>
                {t.lines.map((l) => (
                  <tr key={l.id} className="border-t border-border">
                    <td className="px-3 py-2 text-xs text-muted-foreground">{l.lineNumber}</td>
                    <td className="px-3 py-2">
                      {l.arPaymentId ? (
                        <Link href={`/ar/payments/${l.arPaymentId}`} className="text-primary hover:underline">
                          Payment {l.paymentNumber}
                        </Link>
                      ) : (
                        <>
                          <span className="font-mono text-xs text-muted-foreground">{l.accountCode}</span> {l.accountName}
                        </>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{l.description}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{fmt(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {t.memo && <p className="text-xs text-muted-foreground">Memo: {t.memo}</p>}
        <AttachmentsSection entityType="bank_transaction" entityId={id} />
      </div>
    </AppShell>
  );
}

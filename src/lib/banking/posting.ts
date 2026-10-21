import { auditFields, type Ctx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import type { BankTransaction, BankTransactionLine } from "@/lib/db/schema";
import { AppError } from "@/lib/errors";
import { createAndPostJournal, reverseJournal, type JournalLineInput } from "@/lib/gl/posting";
import { sourceCodeId } from "@/lib/gl/lookups";
import { recordPurchase } from "@/lib/inventory/documents";
import { voidMovements } from "@/lib/inventory/engine";
import { money, toDbMoney } from "@/lib/money";

/**
 * Bank transactions → GL, in the caller's transaction.
 *
 *   expense / check  Dr each line / Cr bank (total)
 *   deposit          Dr bank (total) / Cr each line
 *   transfer         Dr to-account / Cr from-account
 *
 * A negative line flips its side. Bank-side lines carry bank_account_id so
 * registers and reconciliation find them.
 */

function postingFailed(result: { error: string; code: string; meta?: Record<string, unknown> }) {
  return new AppError("posting_failed", result.error, { postingCode: result.code, ...result.meta });
}

const LABEL: Record<BankTransaction["type"], string> = {
  expense: "Expense",
  check: "Check",
  deposit: "Deposit",
  transfer: "Transfer",
};

export function bankTxnLabel(t: Pick<BankTransaction, "type" | "txnNumber" | "reference">): string {
  return `${LABEL[t.type]} ${t.type === "check" && t.reference ? `#${t.reference}` : t.txnNumber}`;
}

export async function postBankTransactionToGl(
  ctx: Ctx,
  txn: BankTransaction,
  lines: BankTransactionLine[]
): Promise<{ journalId: string; journalNumber: string }> {
  const { actor, tx } = ctx;
  const org = actor.organizationId;
  const label = bankTxnLabel(txn);
  const payeeMemo = txn.payeeName ?? txn.memo ?? label;
  const total = money(txn.totalAmount);
  const jeLines: JournalLineInput[] = [];

  if (txn.type === "transfer") {
    if (!txn.transferAccountId) throw new AppError("invalid_state", "Transfer has no destination account.");
    jeLines.push(
      { accountId: txn.transferAccountId, debit: toDbMoney(total), memo: txn.memo ?? label, bankAccountId: txn.transferAccountId },
      { accountId: txn.bankAccountId, credit: toDbMoney(total), memo: txn.memo ?? label, bankAccountId: txn.bankAccountId }
    );
  } else {
    const moneyIn = txn.type === "deposit";
    jeLines.push({
      accountId: txn.bankAccountId,
      ...(moneyIn ? { debit: toDbMoney(total) } : { credit: toDbMoney(total) }),
      memo: payeeMemo,
      reference: txn.reference ?? undefined,
      vendorId: txn.vendorId ?? undefined,
      customerId: txn.customerId ?? undefined,
      bankAccountId: txn.bankAccountId,
    });
    for (const l of lines) {
      const amt = money(l.amount);
      if (amt.isZero()) continue;
      // Expense lines are debits and deposit lines credits; negatives flip.
      const debitSide = moneyIn ? amt.lt(0) : amt.gt(0);
      jeLines.push({
        accountId: l.accountId,
        ...(debitSide ? { debit: toDbMoney(amt.abs()) } : { credit: toDbMoney(amt.abs()) }),
        memo: l.description ?? payeeMemo,
        customerId: l.customerId ?? txn.customerId ?? undefined,
        vendorId: txn.vendorId ?? undefined,
        dimensions: l.dimensions.length > 0 ? l.dimensions : undefined,
      });
    }
  }

  const moneyIn = txn.type === "deposit";
  const result = await createAndPostJournal(
    {
      organizationId: org,
      actorId: actor.userId,
      actor,
      journalDate: txn.txnDate,
      sourceCodeId: await sourceCodeId(tx, org, moneyIn ? "CR" : "CD"),
      source: moneyIn ? "cash_receipt" : "cash_disbursement",
      description: `${label}${txn.payeeName ? ` · ${txn.payeeName}` : ""}`,
      currency: txn.currency,
      exchangeRate: txn.exchangeRate,
      documentNo: txn.reference ?? txn.txnNumber,
      lines: jeLines,
    },
    tx
  );
  if (!result.ok) throw postingFailed(result);
  if (!moneyIn && txn.type !== "transfer") {
    await recordPurchase(ctx, { sourceType: "bank_transaction", sourceId: txn.id, label, date: txn.txnDate, exchangeRate: txn.exchangeRate, lines });
  }

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(actor),
      event: "bank.transaction.posted",
      entityType: "bank_transaction",
      entityId: txn.id,
      metadata: { txnNumber: txn.txnNumber, type: txn.type, journalId: result.journalId, total: txn.totalAmount },
    },
    tx
  );
  return { journalId: result.journalId, journalNumber: result.journalNumber };
}

export async function voidBankTransactionFromGl(
  ctx: Ctx,
  txn: BankTransaction,
  reason: string
): Promise<{ journalId: string }> {
  const { actor, tx } = ctx;
  if (!txn.glJournalId) throw new AppError("invalid_state", "This transaction has no posted journal to reverse.");
  const result = await reverseJournal(
    txn.glJournalId,
    {
      actorId: actor.userId,
      actor,
      organizationId: actor.organizationId,
      description: `Void of ${bankTxnLabel(txn).toLowerCase()}: ${reason}`,
    },
    tx
  );
  if (!result.ok) throw postingFailed(result);
  await voidMovements(ctx, "bank_transaction", txn.id);
  await writeAudit(
    {
      organizationId: actor.organizationId,
      ...auditFields(actor),
      event: "bank.transaction.voided",
      entityType: "bank_transaction",
      entityId: txn.id,
      metadata: { txnNumber: txn.txnNumber, reason, reversalJournalId: result.journalId },
    },
    tx
  );
  return { journalId: result.journalId };
}

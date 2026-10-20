import { and, eq, sql } from "drizzle-orm";
import { apBills, type ApPayment } from "@/lib/db/schema";
import { auditFields, type Ctx, type Tx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import {
  createAndPostJournal,
  reverseJournal,
  type JournalLineInput,
} from "@/lib/gl/posting";
import { requireBankingAccount } from "@/lib/banking/common";
import { accountByCode, controlAccount, sourceCodeId } from "@/lib/gl/lookups";
import { money, toDbMoney } from "@/lib/money";
import { billSettled } from "./balances";

/**
 * AP payment posting. For a given draft payment:
 *   Dr AP Control for total applied (applied + discount per application)
 *   Cr Bank for net cash out (applied − discount)
 *   Cr Purchase Discounts Earned for any discount taken (if > 0)
 *
 * After posting, each referenced bill's paid status is recomputed —
 * flipping to `paid` when sum of applications across ALL posted payments
 * covers bill.totalAmount.
 *
 * Source code: CD (Cash Disbursements). Journal source enum: cash_disbursement.
 */
export async function postPaymentToGl(
  ctx: Ctx,
  payment: ApPayment
): Promise<{ journalId: string; journalNumber: string }> {
  const { actor, tx } = ctx;
  const organizationId = actor.organizationId;

  const apControl = await controlAccount(tx, organizationId, "payables");
  await requireBankingAccount(tx, organizationId, payment.bankAccountId, { label: "Payment account" });

  const discountTotal = money(payment.discountAmount);
  const discountAccount = discountTotal.gt(0)
    ? await accountByCode(tx, organizationId, "4940", "Purchase Discounts Earned")
    : null;

  const cdSource = await sourceCodeId(tx, organizationId, "CD");

  const appliedTotal = money(payment.appliedAmount);
  const netTotal = money(payment.netAmount);

  const lines: JournalLineInput[] = [
    {
      accountId: apControl.id,
      debit: toDbMoney(appliedTotal),
      memo: `Bill payment ${payment.paymentNumber}`,
      vendorId: payment.vendorId,
    },
    {
      accountId: payment.bankAccountId,
      credit: toDbMoney(netTotal),
      memo: `Bill payment ${payment.paymentNumber} · ${payment.method}${
        payment.reference ? ` ref ${payment.reference}` : ""
      }`,
      vendorId: payment.vendorId,
      bankAccountId: payment.bankAccountId,
    },
  ];
  if (discountAccount) {
    lines.push({
      accountId: discountAccount.id,
      credit: toDbMoney(discountTotal),
      memo: `Early-pay discount earned on payment ${payment.paymentNumber}`,
      vendorId: payment.vendorId,
    });
  }

  const result = await createAndPostJournal(
    {
      organizationId,
      actorId: actor.userId,
      actor,
      journalDate: payment.paymentDate,
      sourceCodeId: cdSource,
      source: "cash_disbursement",
      description: `Bill payment ${payment.paymentNumber}`,
      currency: payment.currency,
      exchangeRate: payment.exchangeRate,
      documentNo: payment.reference ?? payment.paymentNumber,
      lines,
    },
    tx
  );

  if (!result.ok) {
    throw new AppError("posting_failed", result.error, {
      postingCode: result.code,
      ...result.meta,
    });
  }

  await writeAudit(
    {
      organizationId,
      ...auditFields(actor),
      event: "ap.payment.posted",
      entityType: "ap_payment",
      entityId: payment.id,
      metadata: {
        paymentNumber: payment.paymentNumber,
        journalId: result.journalId,
        applied: toDbMoney(appliedTotal),
        discount: toDbMoney(discountTotal),
        net: toDbMoney(netTotal),
      },
    },
    tx
  );

  return { journalId: result.journalId, journalNumber: result.journalNumber };
}

/**
 * What's been settled against a bill: posted payments (cash + discount)
 * plus vendor credits applied. See ./balances.ts.
 */
export async function billAppliedTotal(tx: Tx, billId: string): Promise<ReturnType<typeof money>> {
  return billSettled(tx, billId);
}

/**
 * Recompute a bill's paid status from what's settled (posted payments and
 * vendor credits).
 * Flips status 'posted' ↔ 'paid' as appropriate. Also clears paidAt if a
 * previously-paid bill drops below full coverage (e.g. a payment voided).
 */
export async function recomputeBillPaymentStatus(
  tx: Tx,
  organizationId: string,
  billId: string
): Promise<void> {
  const [bill] = await tx
    .select()
    .from(apBills)
    .where(
      and(eq(apBills.id, billId), eq(apBills.organizationId, organizationId))
    );
  if (!bill) return;
  // Only posted ↔ paid moves here; every other status is owned elsewhere.
  if (bill.status !== "posted" && bill.status !== "paid") return;

  const applied = await billAppliedTotal(tx, billId);
  const total = money(bill.totalAmount);
  const fullyPaid = applied.gte(total) && total.gt(0);

  const newStatus = fullyPaid ? "paid" : "posted";
  if (newStatus !== bill.status) {
    await tx
      .update(apBills)
      .set({
        status: newStatus,
        paidAt: fullyPaid ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(eq(apBills.id, billId));
  }
}

/**
 * Reverse a posted payment's GL impact. The caller marks the payment voided
 * and re-runs paid-status recompute on every affected bill.
 */
export async function voidPaymentFromGl(
  ctx: Ctx,
  payment: ApPayment,
  reason: string
): Promise<{ journalId: string }> {
  const { actor, tx } = ctx;
  if (!payment.glJournalId) {
    throw new AppError("invalid_state", "Payment has no posted GL journal to reverse.");
  }

  const result = await reverseJournal(
    payment.glJournalId,
    {
      actorId: actor.userId,
      actor,
      organizationId: actor.organizationId,
      description: `Void of bill payment ${payment.paymentNumber}: ${reason}`,
    },
    tx
  );
  if (!result.ok) {
    throw new AppError("posting_failed", `GL reversal failed: ${result.error}`, {
      postingCode: result.code,
    });
  }

  await writeAudit(
    {
      organizationId: actor.organizationId,
      ...auditFields(actor),
      event: "ap.payment.voided",
      entityType: "ap_payment",
      entityId: payment.id,
      metadata: {
        paymentNumber: payment.paymentNumber,
        reason,
        reversalJournalId: result.journalId,
      },
    },
    tx
  );

  return { journalId: result.journalId };
}

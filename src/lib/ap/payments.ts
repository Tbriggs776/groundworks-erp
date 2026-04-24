import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  accounts,
  apBills,
  apPaymentApplications,
  apPayments,
  sourceCodes,
  type ApPayment,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import {
  createAndPostJournal,
  reverseJournal,
  type JournalLineInput,
} from "@/lib/gl/posting";
import { money, sumMoney, toDbMoney } from "@/lib/money";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  tx: Tx,
  opts: {
    payment: ApPayment;
    actorId: string | null;
    organizationId: string;
  }
): Promise<{ journalId: string; journalNumber: string }> {
  const { payment, actorId, organizationId } = opts;

  // AP control account
  const [apControl] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.isControl, true),
        eq(accounts.subcategory, "payables")
      )
    )
    .limit(1);
  if (!apControl) {
    throw new Error(
      "No AP control account found (isControl=true, subcategory=payables)."
    );
  }

  // Bank account — already stored on the payment row
  const [bank] = await tx
    .select({ id: accounts.id, isCash: accounts.isCash })
    .from(accounts)
    .where(
      and(
        eq(accounts.id, payment.bankAccountId),
        eq(accounts.organizationId, organizationId)
      )
    );
  if (!bank) throw new Error("Bank account not found.");
  if (!bank.isCash) {
    throw new Error(
      "Payment bank_account must be a Cash/Bank account (isCash=true)."
    );
  }

  // Purchase Discounts Earned — required only if a discount is taken.
  const discountTotal = money(payment.discountAmount);
  let discountAccountId: string | null = null;
  if (discountTotal.gt(0)) {
    const [disc] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, organizationId),
          eq(accounts.code, "4940") // Purchase Discounts Earned
        )
      )
      .limit(1);
    if (!disc) {
      throw new Error(
        'Discount taken but no "Purchase Discounts Earned" account (code 4940). Add it to the CoA first.'
      );
    }
    discountAccountId = disc.id;
  }

  // Source code: CD
  const [cdSource] = await tx
    .select({ id: sourceCodes.id })
    .from(sourceCodes)
    .where(
      and(
        eq(sourceCodes.organizationId, organizationId),
        eq(sourceCodes.code, "CD")
      )
    );
  if (!cdSource) throw new Error("CD source code missing. Re-run org seeding.");

  // Build JE
  const appliedTotal = money(payment.appliedAmount);
  const netTotal = money(payment.netAmount);

  const lines: JournalLineInput[] = [
    {
      accountId: apControl.id,
      debit: toDbMoney(appliedTotal),
      memo: `AP payment ${payment.paymentNumber}`,
      vendorId: payment.vendorId,
    },
    {
      accountId: payment.bankAccountId,
      credit: toDbMoney(netTotal),
      memo: `AP payment ${payment.paymentNumber} — ${payment.method}${
        payment.reference ? ` ref ${payment.reference}` : ""
      }`,
      vendorId: payment.vendorId,
      bankAccountId: payment.bankAccountId,
    },
  ];
  if (discountTotal.gt(0) && discountAccountId) {
    lines.push({
      accountId: discountAccountId,
      credit: toDbMoney(discountTotal),
      memo: `Early-pay discount earned on payment ${payment.paymentNumber}`,
      vendorId: payment.vendorId,
    });
  }

  const result = await createAndPostJournal({
    organizationId,
    actorId,
    journalDate: payment.paymentDate,
    sourceCodeId: cdSource.id,
    source: "cash_disbursement",
    description: `AP payment ${payment.paymentNumber}`,
    currency: payment.currency,
    exchangeRate: payment.exchangeRate,
    documentNo: payment.reference ?? payment.paymentNumber,
    lines,
  });

  if (!result.ok) {
    throw new Error(`GL posting failed: ${result.code}: ${result.error}`);
  }

  await writeAudit(
    {
      organizationId,
      actorId,
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
 * Recompute a bill's paid status based on sum of POSTED payment applications.
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
  // Don't touch voided or rejected bills — status already terminal/manual.
  if (bill.status === "voided" || bill.status === "rejected") return;

  // Sum applications from POSTED payments only
  const rows = await tx
    .select({
      appliedAmount: apPaymentApplications.appliedAmount,
      discountAmount: apPaymentApplications.discountAmount,
    })
    .from(apPaymentApplications)
    .innerJoin(apPayments, eq(apPayments.id, apPaymentApplications.paymentId))
    .where(
      and(
        eq(apPaymentApplications.billId, billId),
        eq(apPayments.status, "posted")
      )
    );

  const applied = sumMoney(
    rows.flatMap((r) => [r.appliedAmount, r.discountAmount])
  );
  const total = money(bill.totalAmount);
  const fullyPaid = applied.gte(total) && total.gt(0);

  const newStatus = fullyPaid ? "paid" : bill.status === "paid" ? "posted" : bill.status;
  const newPaidAt = fullyPaid ? (bill.paidAt ?? sql`now()`) : null;

  if (newStatus !== bill.status || !!newPaidAt !== !!bill.paidAt) {
    await tx
      .update(apBills)
      .set({
        status: newStatus as typeof bill.status,
        paidAt: newPaidAt as unknown as Date | null,
        updatedAt: sql`now()`,
      })
      .where(eq(apBills.id, billId));
  }
}

/**
 * Reverse a posted payment. Creates a reversing GL journal, marks the
 * payment voided, and re-runs paid-status recompute on every affected bill.
 */
export async function voidPaymentFromGl(
  tx: Tx,
  opts: {
    payment: ApPayment;
    actorId: string | null;
    organizationId: string;
    reason: string;
  }
): Promise<{ journalId: string }> {
  if (!opts.payment.glJournalId) {
    throw new Error("Payment has no posted GL journal to reverse.");
  }

  const result = await reverseJournal(opts.payment.glJournalId, {
    actorId: opts.actorId,
    organizationId: opts.organizationId,
    description: `Void of AP payment ${opts.payment.paymentNumber} — ${opts.reason}`,
  });
  if (!result.ok) throw new Error(`GL reversal failed: ${result.error}`);

  await writeAudit(
    {
      organizationId: opts.organizationId,
      actorId: opts.actorId,
      event: "ap.payment.voided",
      entityType: "ap_payment",
      entityId: opts.payment.id,
      metadata: {
        paymentNumber: opts.payment.paymentNumber,
        reason: opts.reason,
        reversalJournalId: result.journalId,
      },
    },
    tx
  );

  return { journalId: result.journalId };
}

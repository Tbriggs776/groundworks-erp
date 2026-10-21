import { and, asc, eq, sql } from "drizzle-orm";
import { arInvoiceLines, arInvoices, type ArInvoice, type ArPayment } from "@/lib/db/schema";
import { auditFields, type Ctx, type Tx } from "@/lib/actor";
import { writeAudit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import {
  createAndPostJournal,
  reverseJournal,
  type JournalLineInput,
} from "@/lib/gl/posting";
import { accountByCode, controlAccount, sourceCodeId } from "@/lib/gl/lookups";
import { money, toDbMoney } from "@/lib/money";
import { invoiceSettled } from "./balances";
import { voidMovements } from "@/lib/inventory/engine";
import { postSalesDocument } from "./documents";

/**
 * AR → GL.
 *
 * Invoice:  Dr AR control (total) / Cr each line's income account, Cr each
 *           tax agency's liability. A negative line (a discount line)
 *           debits its account instead. See ./documents.ts.
 * Payment:  Dr deposit account (cash) + Dr 4950 Sales Discounts (discount)
 *           / Cr AR control (cash + discount).
 *
 * Both run in the caller's transaction (ctx.tx).
 */

function postingFailed(result: { error: string; code: string; meta?: Record<string, unknown> }) {
  return new AppError("posting_failed", result.error, {
    postingCode: result.code,
    ...result.meta,
  });
}

export async function postInvoiceToGl(
  ctx: Ctx,
  invoice: ArInvoice
): Promise<{ journalId: string; journalNumber: string }> {
  const ar = await controlAccount(ctx.tx, ctx.actor.organizationId, "receivables");
  const lines = await ctx.tx
    .select()
    .from(arInvoiceLines)
    .where(eq(arInvoiceLines.invoiceId, invoice.id))
    .orderBy(asc(arInvoiceLines.lineNumber));
  if (lines.length === 0) throw new AppError("invalid_state", "Invoice has no lines.");
  return postSalesDocument(ctx, {
    direction: "sale",
    ref: { invoiceId: invoice.id },
    number: invoice.invoiceNumber,
    label: `Invoice ${invoice.invoiceNumber}`,
    date: invoice.invoiceDate,
    currency: invoice.currency,
    exchangeRate: invoice.exchangeRate,
    total: invoice.totalAmount,
    customerId: invoice.customerId,
    counter: { accountId: ar.id, bank: false, memo: `Invoice ${invoice.invoiceNumber}` },
    lines,
    sourceCode: "SJ",
    source: "ar",
    auditEvent: "ar.invoice.posted",
    entityType: "ar_invoice",
    entityId: invoice.id,
  });
}

export async function voidInvoiceFromGl(
  ctx: Ctx,
  invoice: ArInvoice,
  reason: string
): Promise<{ journalId: string }> {
  const { actor, tx } = ctx;
  if (!invoice.glJournalId) {
    throw new AppError("invalid_state", "Invoice has no posted journal to reverse.");
  }
  const result = await reverseJournal(
    invoice.glJournalId,
    {
      actorId: actor.userId,
      actor,
      organizationId: actor.organizationId,
      description: `Void of invoice ${invoice.invoiceNumber}: ${reason}`,
    },
    tx
  );
  if (!result.ok) throw postingFailed(result);
  await voidMovements(ctx, "ar_invoice", invoice.id);

  await writeAudit(
    {
      organizationId: actor.organizationId,
      ...auditFields(actor),
      event: "ar.invoice.voided",
      entityType: "ar_invoice",
      entityId: invoice.id,
      metadata: { invoiceNumber: invoice.invoiceNumber, reason, reversalJournalId: result.journalId },
    },
    tx
  );
  return { journalId: result.journalId };
}

export async function postCustomerPaymentToGl(
  ctx: Ctx,
  payment: ArPayment
): Promise<{ journalId: string; journalNumber: string }> {
  const { actor, tx } = ctx;
  const org = actor.organizationId;
  const ar = await controlAccount(tx, org, "receivables");
  const crSource = await sourceCodeId(tx, org, "CR");
  const cash = money(payment.amount);
  const discount = money(payment.discountAmount);
  const discountAccount = discount.gt(0)
    ? await accountByCode(tx, org, "4950", "Sales Discounts")
    : null;

  const lines: JournalLineInput[] = [
    {
      accountId: payment.depositAccountId,
      debit: toDbMoney(cash),
      memo: `Payment ${payment.paymentNumber} · ${payment.method}${
        payment.reference ? ` ref ${payment.reference}` : ""
      }`,
      customerId: payment.customerId,
      bankAccountId: payment.depositAccountId,
    },
  ];
  if (discountAccount) {
    lines.push({
      accountId: discountAccount.id,
      debit: toDbMoney(discount),
      memo: `Early-pay discount on payment ${payment.paymentNumber}`,
      customerId: payment.customerId,
    });
  }
  lines.push({
    accountId: ar.id,
    credit: toDbMoney(cash.plus(discount)),
    memo: `Payment ${payment.paymentNumber}`,
    customerId: payment.customerId,
  });

  const result = await createAndPostJournal(
    {
      organizationId: org,
      actorId: actor.userId,
      actor,
      journalDate: payment.paymentDate,
      sourceCodeId: crSource,
      source: "cash_receipt",
      description: `Customer payment ${payment.paymentNumber}`,
      currency: payment.currency,
      exchangeRate: payment.exchangeRate,
      documentNo: payment.reference ?? payment.paymentNumber,
      lines,
    },
    tx
  );
  if (!result.ok) throw postingFailed(result);

  await writeAudit(
    {
      organizationId: org,
      ...auditFields(actor),
      event: "ar.payment.posted",
      entityType: "ar_payment",
      entityId: payment.id,
      metadata: {
        paymentNumber: payment.paymentNumber,
        journalId: result.journalId,
        amount: payment.amount,
        discount: payment.discountAmount,
      },
    },
    tx
  );
  return { journalId: result.journalId, journalNumber: result.journalNumber };
}

export async function voidCustomerPaymentFromGl(
  ctx: Ctx,
  payment: ArPayment,
  reason: string
): Promise<{ journalId: string }> {
  const { actor, tx } = ctx;
  if (!payment.glJournalId) {
    throw new AppError("invalid_state", "Payment has no posted journal to reverse.");
  }
  const result = await reverseJournal(
    payment.glJournalId,
    {
      actorId: actor.userId,
      actor,
      organizationId: actor.organizationId,
      description: `Void of customer payment ${payment.paymentNumber}: ${reason}`,
    },
    tx
  );
  if (!result.ok) throw postingFailed(result);

  await writeAudit(
    {
      organizationId: actor.organizationId,
      ...auditFields(actor),
      event: "ar.payment.voided",
      entityType: "ar_payment",
      entityId: payment.id,
      metadata: { paymentNumber: payment.paymentNumber, reason, reversalJournalId: result.journalId },
    },
    tx
  );
  return { journalId: result.journalId };
}

/** Σ settled against an invoice: posted payments (cash + discount) and credits applied. */
export async function invoiceAppliedTotal(tx: Tx, invoiceId: string) {
  return invoiceSettled(tx, invoiceId);
}

/** open ↔ paid, from what has been settled. Other statuses are owned elsewhere. */
export async function recomputeInvoiceStatus(
  tx: Tx,
  organizationId: string,
  invoiceId: string
): Promise<void> {
  const [inv] = await tx
    .select()
    .from(arInvoices)
    .where(and(eq(arInvoices.id, invoiceId), eq(arInvoices.organizationId, organizationId)));
  if (!inv || (inv.status !== "open" && inv.status !== "paid")) return;
  const applied = await invoiceAppliedTotal(tx, invoiceId);
  const fullyPaid = applied.gte(money(inv.totalAmount)) && money(inv.totalAmount).gt(0);
  const next = fullyPaid ? "paid" : "open";
  if (next !== inv.status) {
    await tx
      .update(arInvoices)
      .set({ status: next, paidAt: fullyPaid ? sql`now()` : null, updatedAt: sql`now()` })
      .where(eq(arInvoices.id, invoiceId));
  }
}

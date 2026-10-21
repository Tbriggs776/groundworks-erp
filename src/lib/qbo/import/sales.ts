import { sql, eq } from "drizzle-orm";
import {
  arInvoiceLines,
  arInvoices,
  creditMemoLines,
  creditMemos,
  refundReceiptLines,
  refundReceipts,
  salesReceiptLines,
  salesReceipts,
} from "@/lib/db/schema";
import { creatorFields } from "@/lib/actor";
import { postSalesDocument, writeTaxLines } from "@/lib/ar/documents";
import { postInvoiceToGl } from "@/lib/ar/posting";
import { undepositedFunds } from "@/lib/ar/sales-receipts";
import { AppError } from "@/lib/errors";
import { controlAccount } from "@/lib/gl/lookups";
import type { QboRecord } from "../client";
import { pagedStep, type Kit, type Ref } from "./kit";
import {
  auditVoided,
  currencyOf,
  dateOf,
  docNumber,
  importTxn,
  isVoided,
  later,
  methodOf,
  salesLines,
  salesTax,
  salesTotals,
  text,
  voidedAt,
} from "./txn";

/**
 * Sales history: invoices, sales receipts, credit memos, and refund
 * receipts. Each keeps QuickBooks' number (when it's free), lines, and tax
 * amounts, and posts through the app's own posting, so the ledger,
 * statements, and reports see them like any other document. Nothing is
 * applied automatically: payments in QuickBooks say what paid what.
 */

const PRELOAD = ["Customer", "Item", "Account", "Class", "Department", "TaxRate", "TaxCode", "PaymentMethod"];
const VOID_REASON = "Voided in QuickBooks";

async function customerOf(kit: Kit, r: QboRecord, required: true): Promise<string>;
async function customerOf(kit: Kit, r: QboRecord, required: false): Promise<string | null>;
async function customerOf(kit: Kit, r: QboRecord, required: boolean) {
  const ref = r.CustomerRef as Ref;
  const id = await kit.local("Customer", ref);
  if (!id && (required || ref?.value)) throw new AppError("invalid_input", `its customer ${ref?.name ?? ""} isn't here.`.replace("  ", " "));
  return id;
}

const memoOf = (r: QboRecord) => text((r.CustomerMemo as { value?: string } | undefined)?.value, 2000);
const voidFields = (kit: Kit, r: QboRecord) => ({
  status: "voided" as const,
  voidedAt: voidedAt(r),
  voidedBy: kit.ctx.actor.userId,
  voidReason: VOID_REASON,
});
const posted = (kit: Kit, journalId: string) => ({ postedAt: sql`now()`, postedBy: kit.ctx.actor.userId, glJournalId: journalId, updatedAt: sql`now()` });

/** Lines, tax, and totals with QuickBooks' amounts. */
async function prepare(kit: Kit, r: QboRecord, label: string) {
  const lines = await salesLines(kit, r, label);
  const tax = await salesTax(kit, r, lines, label);
  const { total, ...totals } = salesTotals(kit, label, r, lines, tax);
  await kit.year(dateOf(r));
  return { lines, tax, totals, total };
}

export const invoicesStep = pagedStep({
  key: "invoices",
  label: "Invoices",
  entity: "Invoice",
  preload: PRELOAD,
  async importOne(kit, r) {
    const label = `Invoice ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "Invoice", r, label, async () => {
      const customerId = await customerOf(kit, r, true);
      const invoiceNumber = await docNumber(kit, "Invoice", "ar_invoices", "invoice_number", r.DocNumber, "INV");
      const date = dateOf(r);
      const header = {
        organizationId: kit.org,
        invoiceNumber,
        customerId,
        invoiceDate: date,
        dueDate: later(String(r.DueDate ?? date), date),
        ...(await currencyOf(kit, r)),
        memo: memoOf(r),
        privateNote: text(r.PrivateNote, 2000),
        ...creatorFields(kit.ctx.actor),
      };
      if (isVoided(r)) {
        const [inv] = await kit.ctx.tx.insert(arInvoices).values({ ...header, ...voidFields(kit, r) }).returning();
        await auditVoided(kit, "ar_invoice", inv.id, invoiceNumber);
        await kit.remember("Invoice", r.Id, inv.id);
        return;
      }
      const { lines, tax, totals, total } = await prepare(kit, r, label);
      const [inv] = await kit.ctx.tx.insert(arInvoices).values({ ...header, ...totals, status: "draft" }).returning();
      await kit.ctx.tx.insert(arInvoiceLines).values(lines.map((l, i) => ({ organizationId: kit.org, invoiceId: inv.id, lineNumber: i + 1, ...l })));
      await writeTaxLines(kit.ctx, { invoiceId: inv.id }, tax);
      if (total.isZero()) {
        await kit.ctx.tx.update(arInvoices).set({ status: "paid", paidAt: sql`now()` }).where(eq(arInvoices.id, inv.id));
      } else {
        const { journalId } = await postInvoiceToGl(kit.ctx, inv);
        await kit.ctx.tx.update(arInvoices).set({ status: "open", ...posted(kit, journalId) }).where(eq(arInvoices.id, inv.id));
      }
      await kit.remember("Invoice", r.Id, inv.id);
    });
  },
});

export const salesReceiptsStep = pagedStep({
  key: "sales_receipts",
  label: "Sales receipts",
  entity: "SalesReceipt",
  preload: PRELOAD,
  async importOne(kit, r) {
    const label = `Sales receipt ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "SalesReceipt", r, label, async () => {
      const customerId = await customerOf(kit, r, false);
      const receiptNumber = await docNumber(kit, "Sales receipt", "sales_receipts", "receipt_number", r.DocNumber, "SR");
      const header = {
        organizationId: kit.org,
        receiptNumber,
        customerId,
        receiptDate: dateOf(r),
        method: await methodOf(kit, r.PaymentMethodRef as Ref, "other"),
        reference: text(r.PaymentRefNum, 100),
        depositAccountId: (await kit.local("Account", r.DepositToAccountRef as Ref)) ?? (await undepositedFunds(kit.ctx)),
        ...(await currencyOf(kit, r)),
        memo: memoOf(r),
        privateNote: text(r.PrivateNote, 2000),
        ...creatorFields(kit.ctx.actor),
      };
      if (isVoided(r)) {
        const [sr] = await kit.ctx.tx.insert(salesReceipts).values({ ...header, ...voidFields(kit, r) }).returning();
        await auditVoided(kit, "sales_receipt", sr.id, receiptNumber);
        await kit.remember("SalesReceipt", r.Id, sr.id);
        return;
      }
      const { lines, tax, totals, total } = await prepare(kit, r, label);
      const [sr] = await kit.ctx.tx.insert(salesReceipts).values({ ...header, ...totals, status: "draft" }).returning();
      const rows = await kit.ctx.tx
        .insert(salesReceiptLines)
        .values(lines.map((l, i) => ({ organizationId: kit.org, receiptId: sr.id, lineNumber: i + 1, ...l })))
        .returning();
      await writeTaxLines(kit.ctx, { salesReceiptId: sr.id }, tax);
      let journal: string | null = null;
      if (!total.isZero()) {
        ({ journalId: journal } = await postSalesDocument(kit.ctx, {
          direction: "sale",
          ref: { salesReceiptId: sr.id },
          number: receiptNumber,
          label: `Sales receipt ${receiptNumber}`,
          date: sr.receiptDate,
          currency: sr.currency,
          exchangeRate: sr.exchangeRate,
          total: sr.totalAmount,
          customerId,
          counter: { accountId: sr.depositAccountId, bank: true, memo: `Sales receipt ${receiptNumber} · ${sr.method}${sr.reference ? ` ref ${sr.reference}` : ""}` },
          lines: rows,
          sourceCode: "CR",
          source: "cash_receipt",
          auditEvent: "ar.sales_receipt.posted",
          entityType: "sales_receipt",
          entityId: sr.id,
        }));
      }
      await kit.ctx.tx
        .update(salesReceipts)
        .set({ status: "posted", ...(journal ? posted(kit, journal) : { postedAt: sql`now()` }) })
        .where(eq(salesReceipts.id, sr.id));
      await kit.remember("SalesReceipt", r.Id, sr.id);
    });
  },
});

export const creditMemosStep = pagedStep({
  key: "credit_memos",
  label: "Credit memos",
  entity: "CreditMemo",
  preload: PRELOAD,
  async importOne(kit, r) {
    const label = `Credit memo ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "CreditMemo", r, label, async () => {
      const customerId = await customerOf(kit, r, true);
      const memoNumber = await docNumber(kit, "Credit memo", "credit_memos", "memo_number", r.DocNumber, "CM");
      const header = {
        organizationId: kit.org,
        memoNumber,
        customerId,
        memoDate: dateOf(r),
        ...(await currencyOf(kit, r)),
        memo: memoOf(r),
        privateNote: text(r.PrivateNote, 2000),
        ...creatorFields(kit.ctx.actor),
      };
      if (isVoided(r)) {
        const [m] = await kit.ctx.tx.insert(creditMemos).values({ ...header, ...voidFields(kit, r) }).returning();
        await auditVoided(kit, "credit_memo", m.id, memoNumber);
        await kit.remember("CreditMemo", r.Id, m.id);
        return;
      }
      const { lines, tax, totals, total } = await prepare(kit, r, label);
      const [m] = await kit.ctx.tx.insert(creditMemos).values({ ...header, ...totals, status: "draft" }).returning();
      const rows = await kit.ctx.tx
        .insert(creditMemoLines)
        .values(lines.map((l, i) => ({ organizationId: kit.org, creditMemoId: m.id, lineNumber: i + 1, ...l })))
        .returning();
      await writeTaxLines(kit.ctx, { creditMemoId: m.id }, tax);
      if (total.isZero()) {
        await kit.ctx.tx.update(creditMemos).set({ status: "applied", postedAt: sql`now()` }).where(eq(creditMemos.id, m.id));
      } else {
        const ar = await controlAccount(kit.ctx.tx, kit.org, "receivables");
        const { journalId } = await postSalesDocument(kit.ctx, {
          direction: "return",
          ref: { creditMemoId: m.id },
          number: memoNumber,
          label: `Credit memo ${memoNumber}`,
          date: m.memoDate,
          currency: m.currency,
          exchangeRate: m.exchangeRate,
          total: m.totalAmount,
          customerId,
          counter: { accountId: ar.id, bank: false, memo: `Credit memo ${memoNumber}` },
          lines: rows,
          sourceCode: "SJ",
          source: "ar",
          auditEvent: "ar.credit_memo.posted",
          entityType: "credit_memo",
          entityId: m.id,
        });
        await kit.ctx.tx.update(creditMemos).set({ status: "open", ...posted(kit, journalId) }).where(eq(creditMemos.id, m.id));
      }
      await kit.remember("CreditMemo", r.Id, m.id);
    });
  },
});

export const refundReceiptsStep = pagedStep({
  key: "refund_receipts",
  label: "Refund receipts",
  entity: "RefundReceipt",
  preload: PRELOAD,
  async importOne(kit, r) {
    const label = `Refund receipt ${String(r.DocNumber ?? r.Id)}`;
    return importTxn(kit, "RefundReceipt", r, label, async () => {
      const customerId = await customerOf(kit, r, true);
      const bankAccountId = await kit.local("Account", r.DepositToAccountRef as Ref);
      if (!bankAccountId) throw new AppError("invalid_input", "the account it was paid from isn't here.");
      const refundNumber = await docNumber(kit, "Refund receipt", "refund_receipts", "refund_number", r.DocNumber, "RR");
      const header = {
        organizationId: kit.org,
        refundNumber,
        customerId,
        refundDate: dateOf(r),
        kind: "items" as const,
        method: await methodOf(kit, r.PaymentMethodRef as Ref, "check"),
        reference: text(r.PaymentRefNum, 100),
        bankAccountId,
        ...(await currencyOf(kit, r)),
        memo: memoOf(r),
        privateNote: text(r.PrivateNote, 2000),
        ...creatorFields(kit.ctx.actor),
      };
      if (isVoided(r)) {
        const [rf] = await kit.ctx.tx.insert(refundReceipts).values({ ...header, ...voidFields(kit, r) }).returning();
        await auditVoided(kit, "refund_receipt", rf.id, refundNumber);
        await kit.remember("RefundReceipt", r.Id, rf.id);
        return;
      }
      const { lines, tax, totals, total } = await prepare(kit, r, label);
      const [rf] = await kit.ctx.tx.insert(refundReceipts).values({ ...header, ...totals, status: "draft" }).returning();
      const rows = await kit.ctx.tx
        .insert(refundReceiptLines)
        .values(lines.map((l, i) => ({ organizationId: kit.org, refundId: rf.id, lineNumber: i + 1, ...l })))
        .returning();
      await writeTaxLines(kit.ctx, { refundId: rf.id }, tax);
      let journal: string | null = null;
      if (!total.isZero()) {
        ({ journalId: journal } = await postSalesDocument(kit.ctx, {
          direction: "return",
          ref: { refundId: rf.id },
          number: refundNumber,
          label: `Refund ${refundNumber}`,
          date: rf.refundDate,
          currency: rf.currency,
          exchangeRate: rf.exchangeRate,
          total: rf.totalAmount,
          customerId,
          counter: { accountId: bankAccountId, bank: true, memo: `Refund ${refundNumber} · ${rf.method}${rf.reference ? ` ref ${rf.reference}` : ""}` },
          lines: rows,
          sourceCode: "CD",
          source: "cash_disbursement",
          auditEvent: "ar.refund.posted",
          entityType: "refund_receipt",
          entityId: rf.id,
        }));
      }
      await kit.ctx.tx
        .update(refundReceipts)
        .set({ status: "posted", ...(journal ? posted(kit, journal) : { postedAt: sql`now()` }) })
        .where(eq(refundReceipts.id, rf.id));
      await kit.remember("RefundReceipt", r.Id, rf.id);
    });
  },
});

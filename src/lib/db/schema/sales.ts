import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { paymentMethod, timestamps } from "./_shared";
import { accounts } from "./accounts";
import { agents } from "./agents";
import { arInvoices, arPayments, docLine, lifecycle, taxedTotals } from "./ar";
import { organizations, profiles } from "./identity";
import { glJournals } from "./journals";
import { customers } from "./parties";
import { taxAgencies, taxRates } from "./tax";

/**
 * MORE SALES DOCUMENTS, beside invoices and customer payments (ar.ts):
 *
 *   sales receipt   a cash sale: Dr deposit account / Cr income, Cr tax
 *   credit memo     money the business owes the customer back (a return, a
 *                   goodwill credit): Dr income, Dr tax / Cr AR. It pays
 *                   down invoices or is refunded in cash.
 *   refund receipt  money paid back: either for returned items (Dr income,
 *                   Dr tax / Cr bank) or out of a customer's credit balance
 *                   (Dr AR / Cr bank)
 *
 * Customer credits = a credit memo's unused amount, or a payment's
 * unapplied amount (an overpayment). `ar_credit_applications` records each
 * use of a credit: against an invoice, or paid out by a refund. Applying a
 * credit never posts to the ledger; both sides already sit in AR.
 */

export const salesDocStatus = pgEnum("sales_doc_status", ["draft", "posted", "voided"]);
export const creditMemoStatus = pgEnum("credit_memo_status", ["draft", "open", "applied", "voided"]);
export const refundKind = pgEnum("refund_kind", ["items", "credit"]);
export const taxPaymentStatus = pgEnum("tax_payment_status", ["posted", "voided"]);

// ---------------------------------------------------------------------------
// Sales receipts
// ---------------------------------------------------------------------------

export const salesReceipts = pgTable(
  "sales_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    receiptNumber: text("receipt_number").notNull(),
    /** Optional: a walk-in sale needn't name the customer. */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    receiptDate: date("receipt_date").notNull(),
    method: paymentMethod("method").notNull(),
    reference: text("reference"),
    /** Bank / cash / Undeposited Funds account the money lands in. */
    depositAccountId: uuid("deposit_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    ...taxedTotals(),
    status: salesDocStatus("status").notNull().default("draft"),
    ...lifecycle(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sales_receipts_org_number_key").on(t.organizationId, t.receiptNumber),
    index("sales_receipts_customer_idx").on(t.organizationId, t.customerId),
    index("sales_receipts_status_idx").on(t.organizationId, t.status),
  ]
);

export const salesReceiptLines = pgTable(
  "sales_receipt_lines",
  {
    ...docLine(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => salesReceipts.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("sales_receipt_lines_key").on(t.receiptId, t.lineNumber)]
);

// ---------------------------------------------------------------------------
// Credit memos
// ---------------------------------------------------------------------------

export const creditMemos = pgTable(
  "credit_memos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    memoNumber: text("memo_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    memoDate: date("memo_date").notNull(),
    ...taxedTotals(),
    status: creditMemoStatus("status").notNull().default("draft"),
    ...lifecycle(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("credit_memos_org_number_key").on(t.organizationId, t.memoNumber),
    index("credit_memos_customer_idx").on(t.organizationId, t.customerId),
    index("credit_memos_status_idx").on(t.organizationId, t.status),
  ]
);

export const creditMemoLines = pgTable(
  "credit_memo_lines",
  {
    ...docLine(),
    creditMemoId: uuid("credit_memo_id")
      .notNull()
      .references(() => creditMemos.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("credit_memo_lines_key").on(t.creditMemoId, t.lineNumber)]
);

// ---------------------------------------------------------------------------
// Refund receipts
// ---------------------------------------------------------------------------

export const refundReceipts = pgTable(
  "refund_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    refundNumber: text("refund_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    refundDate: date("refund_date").notNull(),
    /** items: returned goods (has lines). credit: pays out the customer's credit balance. */
    kind: refundKind("kind").notNull().default("items"),
    method: paymentMethod("method").notNull(),
    reference: text("reference"),
    /** Bank / cash / card account the money leaves. */
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** Credit refunds: the credit memo or overpayment paid out (neither = the oldest credits first). */
    creditMemoId: uuid("credit_memo_id").references(() => creditMemos.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id").references(() => arPayments.id, { onDelete: "restrict" }),
    ...taxedTotals(),
    status: salesDocStatus("status").notNull().default("draft"),
    ...lifecycle(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("refund_receipts_org_number_key").on(t.organizationId, t.refundNumber),
    index("refund_receipts_customer_idx").on(t.organizationId, t.customerId),
    index("refund_receipts_status_idx").on(t.organizationId, t.status),
  ]
);

export const refundReceiptLines = pgTable(
  "refund_receipt_lines",
  {
    ...docLine(),
    refundId: uuid("refund_id")
      .notNull()
      .references(() => refundReceipts.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("refund_receipt_lines_key").on(t.refundId, t.lineNumber)]
);

// ---------------------------------------------------------------------------
// Credit applications
// ---------------------------------------------------------------------------

/**
 * One use of a customer credit. Source: a credit memo or a payment's
 * unapplied amount. Target: an invoice it pays down, or a credit refund
 * that pays it out. A credit refund's applications are written when it
 * posts and removed when it's voided.
 */
export const arCreditApplications = pgTable(
  "ar_credit_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    creditMemoId: uuid("credit_memo_id").references(() => creditMemos.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id").references(() => arPayments.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id").references(() => arInvoices.id, { onDelete: "restrict" }),
    refundId: uuid("refund_id").references(() => refundReceipts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    /** For aging as of a date: the later of the credit's and the target's dates. */
    appliedOn: date("applied_on").notNull(),
    /** Applied automatically on posting (not by a person picking it). */
    automatic: boolean("automatic").notNull().default(false),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    check("ar_credit_applications_one_source", sql`num_nonnulls(${t.creditMemoId}, ${t.paymentId}) = 1`),
    check("ar_credit_applications_one_target", sql`num_nonnulls(${t.invoiceId}, ${t.refundId}) = 1`),
    check("ar_credit_applications_positive", sql`${t.amount} > 0`),
    index("ar_credit_apps_memo_idx").on(t.organizationId, t.creditMemoId),
    index("ar_credit_apps_payment_idx").on(t.organizationId, t.paymentId),
    index("ar_credit_apps_invoice_idx").on(t.organizationId, t.invoiceId),
    index("ar_credit_apps_refund_idx").on(t.organizationId, t.refundId),
  ]
);

// ---------------------------------------------------------------------------
// Sales tax on documents, and paying it
// ---------------------------------------------------------------------------

/**
 * Tax per component on one document, frozen when the document is saved.
 * Credit memos and refunds hold positive amounts; reports subtract them.
 */
export const salesTaxLines = pgTable(
  "sales_tax_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id").references(() => arInvoices.id, { onDelete: "cascade" }),
    salesReceiptId: uuid("sales_receipt_id").references(() => salesReceipts.id, { onDelete: "cascade" }),
    creditMemoId: uuid("credit_memo_id").references(() => creditMemos.id, { onDelete: "cascade" }),
    refundId: uuid("refund_id").references(() => refundReceipts.id, { onDelete: "cascade" }),
    taxRateId: uuid("tax_rate_id")
      .notNull()
      .references(() => taxRates.id, { onDelete: "restrict" }),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => taxAgencies.id, { onDelete: "restrict" }),
    liabilityAccountId: uuid("liability_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    ratePercent: numeric("rate_percent", { precision: 9, scale: 4 }).notNull(),
    taxableAmount: numeric("taxable_amount", { precision: 20, scale: 4 }).notNull(),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 4 }).notNull(),
    ...timestamps,
  },
  (t) => [
    check(
      "sales_tax_lines_one_document",
      sql`num_nonnulls(${t.invoiceId}, ${t.salesReceiptId}, ${t.creditMemoId}, ${t.refundId}) = 1`
    ),
    index("sales_tax_lines_agency_idx").on(t.organizationId, t.agencyId),
    index("sales_tax_lines_invoice_idx").on(t.invoiceId),
    index("sales_tax_lines_receipt_idx").on(t.salesReceiptId),
    index("sales_tax_lines_memo_idx").on(t.creditMemoId),
    index("sales_tax_lines_refund_idx").on(t.refundId),
  ]
);

/** Money sent to an agency: Dr its liability account / Cr bank. */
export const salesTaxPayments = pgTable(
  "sales_tax_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentNumber: text("payment_number").notNull(),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => taxAgencies.id, { onDelete: "restrict" }),
    paymentDate: date("payment_date").notNull(),
    /** The filing period this pays, e.g. the quarter's last day. */
    periodEnd: date("period_end").notNull(),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    reference: text("reference"),
    memo: text("memo"),
    status: taxPaymentStatus("status").notNull().default("posted"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    voidGlJournalId: uuid("void_gl_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sales_tax_payments_org_number_key").on(t.organizationId, t.paymentNumber),
    index("sales_tax_payments_agency_idx").on(t.organizationId, t.agencyId),
  ]
);

export type SalesReceipt = typeof salesReceipts.$inferSelect;
export type SalesReceiptLine = typeof salesReceiptLines.$inferSelect;
export type CreditMemo = typeof creditMemos.$inferSelect;
export type CreditMemoLine = typeof creditMemoLines.$inferSelect;
export type RefundReceipt = typeof refundReceipts.$inferSelect;
export type RefundReceiptLine = typeof refundReceiptLines.$inferSelect;
export type ArCreditApplication = typeof arCreditApplications.$inferSelect;
export type SalesTaxLine = typeof salesTaxLines.$inferSelect;
export type SalesTaxPayment = typeof salesTaxPayments.$inferSelect;

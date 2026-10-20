import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
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
import { apBills } from "./ap";
import { organizations, profiles } from "./identity";
import { glJournals } from "./journals";
import { vendors } from "./parties";

/**
 * VENDOR CREDITS AND REFUNDS — the AP mirror of credit memos.
 *
 *   vendor credit  the vendor owes us (a return, a rebate, an overcharge):
 *                  Dr AP / Cr each line's account. Its credit pays down
 *                  the vendor's bills, or comes back as a refund.
 *   vendor refund  money the vendor sends back for a credit:
 *                  Dr the bank (or card) / Cr AP.
 *
 * `ap_credit_applications` records each use of a vendor credit: against a
 * bill, or taken by a refund. Applying never posts to the ledger; both
 * sides already sit in AP.
 */

export const vendorCreditStatus = pgEnum("vendor_credit_status", ["draft", "open", "applied", "voided"]);
export const vendorRefundStatus = pgEnum("vendor_refund_status", ["draft", "posted", "voided"]);

/** Who posted and voided a document, and the journals. */
function lifecycle() {
  return {
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => profiles.id, { onDelete: "set null" }),
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    voidGlJournalId: uuid("void_gl_journal_id").references(() => glJournals.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
  };
}

export const vendorCredits = pgTable(
  "vendor_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    creditNumber: text("credit_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    creditDate: date("credit_date").notNull(),
    /** The vendor's own credit memo number. */
    vendorReference: text("vendor_reference"),
    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }).notNull().default("1"),
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    memo: text("memo"),
    status: vendorCreditStatus("status").notNull().default("draft"),
    ...lifecycle(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("vendor_credits_org_number_key").on(t.organizationId, t.creditNumber),
    index("vendor_credits_vendor_idx").on(t.organizationId, t.vendorId),
    index("vendor_credits_status_idx").on(t.organizationId, t.status),
  ]
);

export const vendorCreditLines = pgTable(
  "vendor_credit_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorCreditId: uuid("vendor_credit_id")
      .notNull()
      .references(() => vendorCredits.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    /** Credited on posting (the expense or asset the original bill hit). */
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    description: text("description"),
    ...timestamps,
  },
  (t) => [uniqueIndex("vendor_credit_lines_credit_line_key").on(t.vendorCreditId, t.lineNumber)]
);

export const vendorRefunds = pgTable(
  "vendor_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    refundNumber: text("refund_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    refundDate: date("refund_date").notNull(),
    method: paymentMethod("method").notNull(),
    reference: text("reference"),
    /** Bank, cash, or credit card account the money comes back to. */
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }).notNull().default("1"),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    /** The credit this refund pays out; null takes the vendor's oldest credits first. */
    vendorCreditId: uuid("vendor_credit_id").references(() => vendorCredits.id, { onDelete: "restrict" }),
    memo: text("memo"),
    status: vendorRefundStatus("status").notNull().default("draft"),
    ...lifecycle(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("vendor_refunds_org_number_key").on(t.organizationId, t.refundNumber),
    index("vendor_refunds_vendor_idx").on(t.organizationId, t.vendorId),
    index("vendor_refunds_status_idx").on(t.organizationId, t.status),
  ]
);

/**
 * One use of a vendor credit: against a bill, or paid out by a refund.
 * Exactly one target. Released (deleted) when either side is voided.
 */
export const apCreditApplications = pgTable(
  "ap_credit_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    vendorCreditId: uuid("vendor_credit_id")
      .notNull()
      .references(() => vendorCredits.id, { onDelete: "restrict" }),
    billId: uuid("bill_id").references(() => apBills.id, { onDelete: "restrict" }),
    vendorRefundId: uuid("vendor_refund_id").references(() => vendorRefunds.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    appliedOn: date("applied_on").notNull(),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("ap_credit_apps_credit_idx").on(t.organizationId, t.vendorCreditId),
    index("ap_credit_apps_bill_idx").on(t.organizationId, t.billId),
    index("ap_credit_apps_refund_idx").on(t.organizationId, t.vendorRefundId),
    check("ap_credit_apps_one_target", sql`(${t.billId} IS NULL) <> (${t.vendorRefundId} IS NULL)`),
    check("ap_credit_apps_positive", sql`${t.amount} > 0`),
  ]
);

export type VendorCredit = typeof vendorCredits.$inferSelect;
export type VendorCreditLine = typeof vendorCreditLines.$inferSelect;
export type VendorRefund = typeof vendorRefunds.$inferSelect;
export type ApCreditApplication = typeof apCreditApplications.$inferSelect;

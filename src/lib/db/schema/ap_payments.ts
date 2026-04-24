import { relations } from "drizzle-orm";
import {
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  apPaymentStatus,
  paymentMethod,
  timestamps,
} from "./_shared";
import { accounts } from "./accounts";
import { apBills } from "./ap";
import { glJournals } from "./journals";
import { organizations, profiles } from "./identity";
import { vendors } from "./parties";

/**
 * AP PAYMENTS — a disbursement that settles one or more posted bills.
 *
 * One payment can apply to multiple bills (a single check cutting across
 * a week's worth of invoices); one bill can be paid across multiple
 * payments (partial/progress billing on the vendor side). The
 * ap_payment_applications join carries the applied amount per (payment,
 * bill) pair, plus any early-pay discount taken on that application.
 *
 * Posting: Dr AP control for the TOTAL applied (closes what's owed),
 * Cr Bank for the cash actually going out (applied − discount),
 * Cr Purchase Discounts Earned for the discount savings.
 *
 * Once all applications sum to bill.totalAmount (applied + discount),
 * the bill flips to status='paid'. Recomputed after every posting/void.
 */
export const apPayments = pgTable(
  "ap_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    paymentNumber: text("payment_number").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),

    paymentDate: date("payment_date").notNull(),
    method: paymentMethod("method").notNull(),
    /** Check number / ACH trace / wire confirmation — whatever the method uses. */
    reference: text("reference"),

    // The bank account being drawn on — must be isCash=true in accounts
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),

    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 })
      .notNull()
      .default("1"),

    /**
     * Gross applied across all applications (before discount offsets).
     * Equals sum(applications.applied_amount + applications.discount_amount).
     */
    appliedAmount: numeric("applied_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    /** Sum of discount_amount across applications. */
    discountAmount: numeric("discount_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    /** Actual cash out = appliedAmount − discountAmount. */
    netAmount: numeric("net_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),

    memo: text("memo"),

    // Lifecycle
    status: apPaymentStatus("status").notNull().default("draft"),

    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),

    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    voidGlJournalId: uuid("void_gl_journal_id").references(
      () => glJournals.id,
      { onDelete: "set null" }
    ),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("ap_payments_org_num_key").on(t.organizationId, t.paymentNumber),
    index("ap_payments_vendor_idx").on(t.organizationId, t.vendorId),
    index("ap_payments_status_idx").on(t.organizationId, t.status),
    index("ap_payments_date_idx").on(t.organizationId, t.paymentDate),
  ]
);

/**
 * AP PAYMENT APPLICATIONS — which bills this payment applies to, and how
 * much goes to each. `applied_amount` is the full amount being taken off
 * the bill's open balance; `discount_amount` is the early-pay discount
 * portion (cash saved vs. face value). The cash actually leaving the
 * bank = applied_amount − discount_amount.
 */
export const apPaymentApplications = pgTable(
  "ap_payment_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => apPayments.id, { onDelete: "cascade" }),
    billId: uuid("bill_id")
      .notNull()
      .references(() => apBills.id, { onDelete: "restrict" }),

    appliedAmount: numeric("applied_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    discountAmount: numeric("discount_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("ap_pay_app_unique").on(t.paymentId, t.billId),
    index("ap_pay_app_bill_idx").on(t.organizationId, t.billId),
  ]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const apPaymentsRelations = relations(apPayments, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [apPayments.organizationId],
    references: [organizations.id],
  }),
  vendor: one(vendors, {
    fields: [apPayments.vendorId],
    references: [vendors.id],
  }),
  bankAccount: one(accounts, {
    fields: [apPayments.bankAccountId],
    references: [accounts.id],
  }),
  glJournal: one(glJournals, {
    fields: [apPayments.glJournalId],
    references: [glJournals.id],
  }),
  applications: many(apPaymentApplications),
}));

export const apPaymentApplicationsRelations = relations(
  apPaymentApplications,
  ({ one }) => ({
    payment: one(apPayments, {
      fields: [apPaymentApplications.paymentId],
      references: [apPayments.id],
    }),
    bill: one(apBills, {
      fields: [apPaymentApplications.billId],
      references: [apBills.id],
    }),
  })
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApPayment = typeof apPayments.$inferSelect;
export type NewApPayment = typeof apPayments.$inferInsert;
export type ApPaymentApplication =
  typeof apPaymentApplications.$inferSelect;
export type NewApPaymentApplication =
  typeof apPaymentApplications.$inferInsert;

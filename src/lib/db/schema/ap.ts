import { relations } from "drizzle-orm";
import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apBillStatus, timestamps } from "./_shared";
import { accounts } from "./accounts";
import { approvalThresholds } from "./approvals";
import { costCodes } from "./cost_codes";
import { organizations, profiles } from "./identity";
import { glJournals } from "./journals";
import { jobs } from "./projects";
import { vendors } from "./parties";

/**
 * AP BILLS — vendor invoices entered into the system. A bill carries:
 *   - External vendor invoice number (what the vendor calls it)
 *   - Internal bill number (our AP-NNNNNN, from the AP number series)
 *   - A header linking to the vendor, dates, totals
 *   - Line items with account + optional job + cost code + amount
 *
 * Lifecycle (enforced in server actions, audit-logged on every transition):
 *   draft → pending_approval → approved | rejected → posted → paid | voided
 *
 * On `posted`: a GL journal is created via createAndPostJournal with
 * source='ap'. Expense accounts are debited; the AP control account (2000)
 * is credited. Job + cost code on lines flow onto gl_lines and into the
 * JOB / COST_CODE dimensions.
 */
export const apBills = pgTable(
  "ap_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Numbers
    billNumber: text("bill_number").notNull(),
    vendorInvoiceNumber: text("vendor_invoice_number"),

    // Parties + dates
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    billDate: date("bill_date").notNull(),
    dueDate: date("due_date").notNull(),
    discountDate: date("discount_date"),
    postingDate: date("posting_date"),

    // Amounts
    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 })
      .notNull()
      .default("1"),
    subtotalAmount: numeric("subtotal_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    discountPercent: numeric("discount_percent", { precision: 10, scale: 6 })
      .notNull()
      .default("0"),
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),

    // Workflow
    status: apBillStatus("status").notNull().default("draft"),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    approvalThresholdId: uuid("approval_threshold_id").references(
      () => approvalThresholds.id,
      { onDelete: "set null" }
    ),

    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    rejectionReason: text("rejection_reason"),

    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),

    paidAt: timestamp("paid_at", { withTimezone: true }),

    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    voidGlJournalId: uuid("void_gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),

    // Metadata
    description: text("description"),
    notes: text("notes"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("ap_bills_org_billnum_key").on(t.organizationId, t.billNumber),
    index("ap_bills_org_status_idx").on(t.organizationId, t.status),
    index("ap_bills_vendor_idx").on(t.organizationId, t.vendorId),
    index("ap_bills_due_idx").on(t.organizationId, t.dueDate),
  ]
);

/**
 * AP BILL LINES — each line hits one expense/asset account plus optional
 * job + cost code tags. No separate dimension table in v1; when the bill
 * posts, job.dimension_value_id and cost_code.dimension_value_id are
 * looked up and written to gl_line_dimensions so the dimension
 * infrastructure carries the tags into GL reports.
 */
export const apBillLines = pgTable(
  "ap_bill_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    billId: uuid("bill_id")
      .notNull()
      .references(() => apBills.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),

    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    costCodeId: uuid("cost_code_id").references(() => costCodes.id, {
      onDelete: "set null",
    }),

    description: text("description"),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("ap_bill_lines_bill_line_key").on(t.billId, t.lineNumber),
    index("ap_bill_lines_job_idx").on(t.organizationId, t.jobId),
  ]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const apBillsRelations = relations(apBills, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [apBills.organizationId],
    references: [organizations.id],
  }),
  vendor: one(vendors, {
    fields: [apBills.vendorId],
    references: [vendors.id],
  }),
  glJournal: one(glJournals, {
    fields: [apBills.glJournalId],
    references: [glJournals.id],
  }),
  voidGlJournal: one(glJournals, {
    fields: [apBills.voidGlJournalId],
    references: [glJournals.id],
    relationName: "void_journal",
  }),
  threshold: one(approvalThresholds, {
    fields: [apBills.approvalThresholdId],
    references: [approvalThresholds.id],
  }),
  lines: many(apBillLines),
}));

export const apBillLinesRelations = relations(apBillLines, ({ one }) => ({
  bill: one(apBills, {
    fields: [apBillLines.billId],
    references: [apBills.id],
  }),
  account: one(accounts, {
    fields: [apBillLines.accountId],
    references: [accounts.id],
  }),
  job: one(jobs, { fields: [apBillLines.jobId], references: [jobs.id] }),
  costCode: one(costCodes, {
    fields: [apBillLines.costCodeId],
    references: [costCodes.id],
  }),
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApBill = typeof apBills.$inferSelect;
export type NewApBill = typeof apBills.$inferInsert;
export type ApBillLine = typeof apBillLines.$inferSelect;
export type NewApBillLine = typeof apBillLines.$inferInsert;

import { relations } from "drizzle-orm";
import {
  type AnyPgColumn,
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
import { apBillStatus, recurringFrequency, recurringStatus, timestamps } from "./_shared";
import { accounts } from "./accounts";
import { agents } from "./agents";
import { approvalThresholds } from "./approvals";
import { organizations, profiles } from "./identity";
import { glJournals } from "./journals";
import { items } from "./ar";
import { vendors } from "./parties";
import { purchaseOrderLines, purchaseOrders } from "./purchase_orders";

/**
 * AP BILLS — vendor invoices entered into the system. A bill carries:
 *   - External vendor invoice number (what the vendor calls it)
 *   - Internal bill number (our AP-NNNNNN, from the AP number series)
 *   - A header linking to the vendor, dates, totals
 *   - Line items with account + amount (+ optional customer for rebilling)
 *
 * Lifecycle (enforced in server actions, audit-logged on every transition):
 *   draft → pending_approval → approved | rejected → posted → paid | voided
 *
 * On `posted`: a GL journal is created via createAndPostJournal with
 * source='ap'. Expense accounts are debited; the AP control account (2000)
 * is credited.
 */
// ---------------------------------------------------------------------------
// Recurring bills: a template plus a schedule.
//   scheduled    the daily run creates the bill and submits it for approval
//   reminder     the daily run creates a draft for someone to review
//   unscheduled  never runs on its own; someone uses it by hand
// Same schedule rules as recurring invoices (see ar.ts).
// ---------------------------------------------------------------------------

export const recurringBillType = pgEnum("recurring_bill_type", ["scheduled", "reminder", "unscheduled"]);

export const recurringBills = pgTable(
  "recurring_bills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "restrict" }),
    type: recurringBillType("type").notNull().default("scheduled"),
    frequency: recurringFrequency("frequency").notNull().default("monthly"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    maxOccurrences: integer("max_occurrences"),
    occurrences: integer("occurrences").notNull().default(0),
    daysInAdvance: integer("days_in_advance").notNull().default(0),
    /** Date of the next bill. Null for unscheduled templates. */
    nextRunDate: date("next_run_date"),
    lastRunDate: date("last_run_date"),
    lastBillId: uuid("last_bill_id").references((): AnyPgColumn => apBills.id, { onDelete: "set null" }),
    /** Why the last run couldn't create or submit its bill, if it couldn't. */
    lastError: text("last_error"),
    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }).notNull().default("1"),
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    description: text("description"),
    notes: text("notes"),
    status: recurringStatus("status").notNull().default("active"),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("recurring_bills_org_name_key").on(t.organizationId, t.name),
    index("recurring_bills_due_idx").on(t.organizationId, t.status, t.nextRunDate),
    index("recurring_bills_vendor_idx").on(t.organizationId, t.vendorId),
  ]
);

export const recurringBillLines = pgTable(
  "recurring_bill_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    recurringBillId: uuid("recurring_bill_id")
      .notNull()
      .references(() => recurringBills.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    description: text("description"),
    ...timestamps,
  },
  (t) => [uniqueIndex("recurring_bill_lines_parent_line_key").on(t.recurringBillId, t.lineNumber)]
);

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

    /** Created from this recurring template. */
    recurringBillId: uuid("recurring_bill_id").references((): AnyPgColumn => recurringBills.id, {
      onDelete: "set null",
    }),

    /** The purchase order this bill bills, if any. */
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id, {
      onDelete: "set null",
    }),

    // Who created the document — a human or an agent (never both). Drives
    // the review queue: agent-created drafts wait there for a human.
    createdBy: uuid("created_by").references(() => profiles.id, {
      onDelete: "set null",
    }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("ap_bills_org_billnum_key").on(t.organizationId, t.billNumber),
    index("ap_bills_org_status_idx").on(t.organizationId, t.status),
    index("ap_bills_vendor_idx").on(t.organizationId, t.vendorId),
    index("ap_bills_due_idx").on(t.organizationId, t.dueDate),
    index("ap_bills_agent_idx").on(t.organizationId, t.createdByAgentId),
    index("ap_bills_po_idx").on(t.organizationId, t.purchaseOrderId),
  ]
);

/**
 * AP BILL LINES — each line hits one expense/asset account.
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

    description: text("description"),

    /** A product bought on this line; inventory items add to stock. */
    itemId: uuid("item_id").references(() => items.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 20, scale: 4 }),
    unitCost: numeric("unit_cost", { precision: 20, scale: 4 }),
    /** Specific identification: the lot bought into, and when it expires. */
    lotNumber: text("lot_number"),
    lotExpiresOn: date("lot_expires_on"),

    /** The purchase order line this bill line bills (progress billing). */
    purchaseOrderLineId: uuid("purchase_order_line_id").references(
      () => purchaseOrderLines.id,
      { onDelete: "set null" }
    ),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("ap_bill_lines_bill_line_key").on(t.billId, t.lineNumber),
    index("ap_bill_lines_po_line_idx").on(t.purchaseOrderLineId),
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
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApBill = typeof apBills.$inferSelect;
export type NewApBill = typeof apBills.$inferInsert;
export type ApBillLine = typeof apBillLines.$inferSelect;
export type RecurringBill = typeof recurringBills.$inferSelect;
export type RecurringBillLine = typeof recurringBillLines.$inferSelect;
export type NewApBillLine = typeof apBillLines.$inferInsert;

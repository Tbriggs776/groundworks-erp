import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { paymentMethod, recurringFrequency, recurringStatus, timestamps } from "./_shared";
import { accounts } from "./accounts";
import { agents } from "./agents";
import { organizations, profiles } from "./identity";
import { glJournals } from "./journals";
import { customers } from "./parties";
import { taxCodes } from "./tax";

/**
 * SALES / AR — products & services, invoices, and customer payments.
 *
 * Invoice lifecycle:   draft → open → paid | voided
 *   draft  — editable, no ledger impact
 *   open   — posted: Dr AR control / Cr income per line. Partially paid
 *            invoices stay open with a smaller balance.
 *   paid   — posted payments (cash + discount) cover the total
 *   voided — reversed via a reversing journal; terminal
 *
 * Customer payment lifecycle: draft → posted → voided
 *   posted: Dr deposit account (cash) + Dr Sales Discounts (discount)
 *           / Cr AR control (cash + discount)
 */

export const itemType = pgEnum("item_type", ["service", "non_inventory", "inventory"]);

export const arInvoiceStatus = pgEnum("ar_invoice_status", [
  "draft",
  "open",
  "paid",
  "voided",
]);

export const arPaymentStatus = pgEnum("ar_payment_status", [
  "draft",
  "posted",
  "voided",
]);

/** Optional analytical tags carried from a document line onto its GL line. */
export type DimensionTag = { dimensionId: string; valueId: string };

// ---------------------------------------------------------------------------
// Column helpers shared by every sales document
// ---------------------------------------------------------------------------

/** Header columns every taxed sales document shares. */
export function taxedTotals() {
  return {
    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }).notNull().default("1"),
    subtotalAmount: numeric("subtotal_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    taxCodeId: uuid("tax_code_id").references(() => taxCodes.id, { onDelete: "restrict" }),
    taxExempt: boolean("tax_exempt").notNull().default(false),
    taxableAmount: numeric("taxable_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    memo: text("memo"),
    privateNote: text("private_note"),
  };
}

/** Lifecycle columns: who created, posted, and voided it, and the journals. */
export function lifecycle() {
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

/** Line columns, the same as invoice lines. Used by every sales document and template. */
export function docLine() {
  return {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),
    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
    description: text("description"),
    quantity: numeric("quantity", { precision: 20, scale: 4 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 20, scale: 4 }).notNull(),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    taxable: boolean("taxable").notNull().default(false),
    dimensions: jsonb("dimensions").$type<DimensionTag[]>().notNull().default([]),
    ...timestamps,
  };
}

// ---------------------------------------------------------------------------
// Products & services
// ---------------------------------------------------------------------------

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    name: text("name").notNull(),
    sku: text("sku"),
    type: itemType("type").notNull().default("service"),
    description: text("description"),

    /** Default unit price on invoices; null = enter per invoice. */
    salesPrice: numeric("sales_price", { precision: 20, scale: 4 }),
    /** Income account credited when this item is sold. */
    incomeAccountId: uuid("income_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** Default cost + expense account when bought (bills). Optional. */
    purchaseCost: numeric("purchase_cost", { precision: 20, scale: 4 }),
    /** Expense account when bought; for inventory items, the COGS account debited when sold. */
    expenseAccountId: uuid("expense_account_id").references(() => accounts.id, {
      onDelete: "restrict",
    }),
    /** Inventory items: the asset account their stock sits in. */
    assetAccountId: uuid("asset_account_id").references(() => accounts.id, { onDelete: "restrict" }),
    /** Inventory items: reorder when on hand falls to this. */
    reorderPoint: numeric("reorder_point", { precision: 20, scale: 4 }),
    /** Charged sales tax when the document has a tax rate. */
    taxable: boolean("taxable").notNull().default(true),

    isActive: boolean("is_active").notNull().default(true),
    externalId: text("external_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("items_org_name_key").on(t.organizationId, t.name),
    index("items_org_sku_idx").on(t.organizationId, t.sku),
  ]
);

// ---------------------------------------------------------------------------
// Estimates (quotes). No ledger impact. Progress invoicing bills them in
// parts: each invoice line can point at the estimate line it bills, and an
// estimate line's billed amount is the sum of its live (not voided) invoice
// lines. Fully billed estimates close on their own.
// ---------------------------------------------------------------------------

export const estimateStatus = pgEnum("estimate_status", ["pending", "accepted", "rejected", "closed"]);

export const estimates = pgTable(
  "estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    estimateNumber: text("estimate_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    estimateDate: date("estimate_date").notNull(),
    expirationDate: date("expiration_date"),
    ...taxedTotals(),
    status: estimateStatus("status").notNull().default("pending"),
    /** Who accepted it on the customer's side, and when. */
    acceptedBy: text("accepted_by"),
    acceptedDate: date("accepted_date"),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("estimates_org_number_key").on(t.organizationId, t.estimateNumber),
    index("estimates_customer_idx").on(t.organizationId, t.customerId),
    index("estimates_status_idx").on(t.organizationId, t.status),
  ]
);

export const estimateLines = pgTable(
  "estimate_lines",
  {
    ...docLine(),
    estimateId: uuid("estimate_id")
      .notNull()
      .references(() => estimates.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("estimate_lines_estimate_line_key").on(t.estimateId, t.lineNumber)]
);

// ---------------------------------------------------------------------------
// Recurring invoices: a template plus a schedule.
//   scheduled    the daily run creates and posts the invoice
//   reminder     the daily run creates a draft for someone to review and post
//   unscheduled  never runs on its own; someone uses it by hand
// The run creates the invoice `days_in_advance` days before next_run_date,
// dated next_run_date, then advances the schedule. It ends after end_date or
// max_occurrences, whichever comes first.
// ---------------------------------------------------------------------------

export const recurringInvoiceType = pgEnum("recurring_invoice_type", ["scheduled", "reminder", "unscheduled"]);

export const recurringInvoices = pgTable(
  "recurring_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    type: recurringInvoiceType("type").notNull().default("scheduled"),
    frequency: recurringFrequency("frequency").notNull().default("monthly"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    maxOccurrences: integer("max_occurrences"),
    occurrences: integer("occurrences").notNull().default(0),
    daysInAdvance: integer("days_in_advance").notNull().default(0),
    /** Date of the next invoice. Null for unscheduled templates. */
    nextRunDate: date("next_run_date"),
    lastRunDate: date("last_run_date"),
    lastInvoiceId: uuid("last_invoice_id").references((): AnyPgColumn => arInvoices.id, { onDelete: "set null" }),
    /** Why the last run couldn't create or post its invoice, if it couldn't. */
    lastError: text("last_error"),
    poNumber: text("po_number"),
    ...taxedTotals(),
    status: recurringStatus("status").notNull().default("active"),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("recurring_invoices_org_name_key").on(t.organizationId, t.name),
    index("recurring_invoices_due_idx").on(t.organizationId, t.status, t.nextRunDate),
    index("recurring_invoices_customer_idx").on(t.organizationId, t.customerId),
  ]
);

export const recurringInvoiceLines = pgTable(
  "recurring_invoice_lines",
  {
    ...docLine(),
    recurringInvoiceId: uuid("recurring_invoice_id")
      .notNull()
      .references(() => recurringInvoices.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("recurring_invoice_lines_parent_line_key").on(t.recurringInvoiceId, t.lineNumber)]
);

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const arInvoices = pgTable(
  "ar_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    invoiceNumber: text("invoice_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date").notNull(),
    /** Customer's PO / reference number. */
    poNumber: text("po_number"),
    /** Progress invoice: the estimate it bills. */
    estimateId: uuid("estimate_id").references(() => estimates.id, { onDelete: "set null" }),
    /** Created from this recurring template. */
    recurringInvoiceId: uuid("recurring_invoice_id").references(() => recurringInvoices.id, { onDelete: "set null" }),

    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 })
      .notNull()
      .default("1"),
    subtotalAmount: numeric("subtotal_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    /** Sales tax rate picked for this invoice; null = no tax. */
    taxCodeId: uuid("tax_code_id").references(() => taxCodes.id, { onDelete: "restrict" }),
    /** The customer was tax exempt when this was saved. */
    taxExempt: boolean("tax_exempt").notNull().default(false),
    /** Σ taxable lines. */
    taxableAmount: numeric("taxable_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 4 }).notNull().default("0"),
    /** subtotal + tax. */
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),

    /** Shown to the customer on the invoice. */
    memo: text("memo"),
    /** Internal only. */
    privateNote: text("private_note"),

    status: arInvoiceStatus("status").notNull().default("draft"),

    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => profiles.id, { onDelete: "set null" }),
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),

    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    voidGlJournalId: uuid("void_gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),

    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ar_invoices_org_number_key").on(t.organizationId, t.invoiceNumber),
    index("ar_invoices_org_status_idx").on(t.organizationId, t.status),
    index("ar_invoices_customer_idx").on(t.organizationId, t.customerId),
    index("ar_invoices_due_idx").on(t.organizationId, t.dueDate),
    index("ar_invoices_agent_idx").on(t.organizationId, t.createdByAgentId),
    index("ar_invoices_estimate_idx").on(t.organizationId, t.estimateId),
    index("ar_invoices_recurring_idx").on(t.organizationId, t.recurringInvoiceId),
  ]
);

export const arInvoiceLines = pgTable(
  "ar_invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => arInvoices.id, { onDelete: "cascade" }),
    lineNumber: integer("line_number").notNull(),

    itemId: uuid("item_id").references(() => items.id, { onDelete: "set null" }),
    description: text("description"),
    quantity: numeric("quantity", { precision: 20, scale: 4 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 20, scale: 4 }).notNull(),
    /** quantity × unit price, rounded to cents. */
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    /** Income account credited. Defaults from the item. */
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    /** Counts toward the taxable amount. Defaults from the item. */
    taxable: boolean("taxable").notNull().default(false),
    dimensions: jsonb("dimensions").$type<DimensionTag[]>().notNull().default([]),
    /** Progress invoicing: the estimate line this bills. */
    estimateLineId: uuid("estimate_line_id").references(() => estimateLines.id, { onDelete: "set null" }),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("ar_invoice_lines_invoice_line_key").on(t.invoiceId, t.lineNumber),
    index("ar_invoice_lines_estimate_line_idx").on(t.estimateLineId),
  ]
);

// ---------------------------------------------------------------------------
// Customer payments
// ---------------------------------------------------------------------------

export const arPayments = pgTable(
  "ar_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    paymentNumber: text("payment_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    paymentDate: date("payment_date").notNull(),
    method: paymentMethod("method").notNull(),
    reference: text("reference"),
    /** Bank / cash / Undeposited Funds account the money lands in. */
    depositAccountId: uuid("deposit_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),

    currency: text("currency").notNull().default("USD"),
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 })
      .notNull()
      .default("1"),
    /** Cash received = Σ applications.amount. */
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull().default("0"),
    /** Early-pay discounts given = Σ applications.discount_amount. */
    discountAmount: numeric("discount_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    memo: text("memo"),

    status: arPaymentStatus("status").notNull().default("draft"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: uuid("posted_by").references(() => profiles.id, { onDelete: "set null" }),
    glJournalId: uuid("gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => profiles.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    voidGlJournalId: uuid("void_gl_journal_id").references(() => glJournals.id, {
      onDelete: "set null",
    }),

    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ar_payments_org_number_key").on(t.organizationId, t.paymentNumber),
    index("ar_payments_customer_idx").on(t.organizationId, t.customerId),
    index("ar_payments_status_idx").on(t.organizationId, t.status),
    index("ar_payments_agent_idx").on(t.organizationId, t.createdByAgentId),
  ]
);

/**
 * Which invoices a payment settles. `amount` is cash applied; the invoice's
 * balance drops by amount + discount_amount (same convention as AP).
 */
export const arPaymentApplications = pgTable(
  "ar_payment_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => arPayments.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => arInvoices.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 20, scale: 4 }).notNull(),
    discountAmount: numeric("discount_amount", { precision: 20, scale: 4 })
      .notNull()
      .default("0"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ar_pay_app_unique").on(t.paymentId, t.invoiceId),
    index("ar_pay_app_invoice_idx").on(t.organizationId, t.invoiceId),
  ]
);

// ---------------------------------------------------------------------------
// Relations + types
// ---------------------------------------------------------------------------

export const itemsRelations = relations(items, ({ one }) => ({
  incomeAccount: one(accounts, {
    fields: [items.incomeAccountId],
    references: [accounts.id],
    relationName: "item_income_account",
  }),
  expenseAccount: one(accounts, {
    fields: [items.expenseAccountId],
    references: [accounts.id],
    relationName: "item_expense_account",
  }),
}));

export const arInvoicesRelations = relations(arInvoices, ({ one, many }) => ({
  customer: one(customers, { fields: [arInvoices.customerId], references: [customers.id] }),
  lines: many(arInvoiceLines),
}));

export const arInvoiceLinesRelations = relations(arInvoiceLines, ({ one }) => ({
  invoice: one(arInvoices, { fields: [arInvoiceLines.invoiceId], references: [arInvoices.id] }),
  item: one(items, { fields: [arInvoiceLines.itemId], references: [items.id] }),
}));

export const arPaymentsRelations = relations(arPayments, ({ one, many }) => ({
  customer: one(customers, { fields: [arPayments.customerId], references: [customers.id] }),
  applications: many(arPaymentApplications),
}));

export const arPaymentApplicationsRelations = relations(arPaymentApplications, ({ one }) => ({
  payment: one(arPayments, {
    fields: [arPaymentApplications.paymentId],
    references: [arPayments.id],
  }),
  invoice: one(arInvoices, {
    fields: [arPaymentApplications.invoiceId],
    references: [arInvoices.id],
  }),
}));

export type Item = typeof items.$inferSelect;
export type Estimate = typeof estimates.$inferSelect;
export type EstimateLine = typeof estimateLines.$inferSelect;
export type RecurringInvoice = typeof recurringInvoices.$inferSelect;
export type RecurringInvoiceLine = typeof recurringInvoiceLines.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ArInvoice = typeof arInvoices.$inferSelect;
export type ArInvoiceLine = typeof arInvoiceLines.$inferSelect;
export type ArPayment = typeof arPayments.$inferSelect;
export type ArPaymentApplication = typeof arPaymentApplications.$inferSelect;

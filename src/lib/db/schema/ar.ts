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
} from "drizzle-orm/pg-core";
import { paymentMethod, timestamps } from "./_shared";
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

export const itemType = pgEnum("item_type", ["service", "non_inventory"]);

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
    expenseAccountId: uuid("expense_account_id").references(() => accounts.id, {
      onDelete: "restrict",
    }),
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

    ...timestamps,
  },
  (t) => [uniqueIndex("ar_invoice_lines_invoice_line_key").on(t.invoiceId, t.lineNumber)]
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
export type NewItem = typeof items.$inferInsert;
export type ArInvoice = typeof arInvoices.$inferSelect;
export type ArInvoiceLine = typeof arInvoiceLines.$inferSelect;
export type ArPayment = typeof arPayments.$inferSelect;
export type ArPaymentApplication = typeof arPaymentApplications.$inferSelect;

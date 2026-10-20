import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { organizations } from "./identity";
import { taxCodes } from "./tax";

/**
 * CUSTOMERS / VENDORS — the "party" master records. They share a similar
 * shape (code + name + addresses + contacts JSONB + active flag) but
 * diverge on business-specific fields.
 *
 * Addresses and contacts use JSONB for pragmatic flexibility:
 *   addresses = [{ type: "billing"|"shipping"|"remit"|"mailing", street1,
 *                  street2, city, state, zip, country }]
 *   contacts  = [{ name, title, email, phone, isPrimary }]
 * If we later need to index addresses by type (for multi-address vendors),
 * promote to a normalized table — JSONB is a one-way door but upgrading is
 * mechanical.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const customerType = pgEnum("customer_type", [
  "commercial",
  "residential",
  "government",
  "non_profit",
  "tax_exempt",
]);

export const vendorType = pgEnum("vendor_type", [
  "subcontractor",
  "supplier",
  "service_provider",
  "tax_authority",
  "utility",
  "other",
]);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    code: text("code").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),

    customerType: customerType("customer_type").notNull().default("commercial"),

    /** Primary billing email / phone (QBO's "Email" and "Phone"). */
    email: text("email"),
    phone: text("phone"),

    // Contact info (see comment above for JSON shape)
    addresses: jsonb("addresses").notNull().default([]),
    contacts: jsonb("contacts").notNull().default([]),

    // Billing
    defaultPaymentTermsDays: integer("default_payment_terms_days")
      .notNull()
      .default(30),
    currency: text("currency").notNull().default("USD"),
    creditLimit: numeric("credit_limit", { precision: 20, scale: 4 }),
    taxExempt: boolean("tax_exempt").notNull().default(false),
    /** Why: resale certificate, nonprofit, government… Printed on documents. */
    taxExemptReason: text("tax_exempt_reason"),
    /** Sales tax rate new documents for this customer start with. */
    defaultTaxCodeId: uuid("default_tax_code_id").references(() => taxCodes.id, { onDelete: "set null" }),
    taxId: text("tax_id"),

    // Free-form metadata
    externalId: text("external_id"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),

    ...timestamps,
  },
  (t) => [uniqueIndex("customers_org_code_key").on(t.organizationId, t.code)]
);

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    code: text("code").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),

    vendorType: vendorType("vendor_type").notNull().default("supplier"),

    email: text("email"),
    phone: text("phone"),

    addresses: jsonb("addresses").notNull().default([]),
    contacts: jsonb("contacts").notNull().default([]),

    // AP terms
    defaultPaymentTermsDays: integer("default_payment_terms_days")
      .notNull()
      .default(30),
    currency: text("currency").notNull().default("USD"),

    // 1099 / tax reporting
    is1099Vendor: boolean("is_1099_vendor").notNull().default(false),
    tin: text("tin"),
    w9OnFile: boolean("w9_on_file").notNull().default(false),

    // Free-form metadata
    externalId: text("external_id"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),

    ...timestamps,
  },
  (t) => [uniqueIndex("vendors_org_code_key").on(t.organizationId, t.code)]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const customersRelations = relations(customers, ({ one }) => ({
  organization: one(organizations, {
    fields: [customers.organizationId],
    references: [organizations.id],
  }),
}));

export const vendorsRelations = relations(vendors, ({ one }) => ({
  organization: one(organizations, {
    fields: [vendors.organizationId],
    references: [organizations.id],
  }),
}));

// ---------------------------------------------------------------------------
// Address / contact JSON shapes (for app-layer typing)
// ---------------------------------------------------------------------------

export type Address = {
  type: "billing" | "shipping" | "remit" | "mailing" | "other";
  street1: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
};

export type Contact = {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  isPrimary?: boolean;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;

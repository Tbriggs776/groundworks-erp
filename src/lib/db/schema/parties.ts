import { relations } from "drizzle-orm";
import {
  boolean,
  date,
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
import { organizations, profiles } from "./identity";

/**
 * CUSTOMERS / VENDORS / EMPLOYEES — the three "party" master records every
 * contractor ERP needs. They share a similar shape (code + name + addresses
 * + contacts JSONB + active flag) but diverge on business-specific fields.
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

export const employeeClassification = pgEnum("employee_classification", [
  "salary",
  "hourly",
  "union",
  "contractor_1099",
  "owner_officer",
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
// Employees
// ---------------------------------------------------------------------------

/**
 * EMPLOYEES — anyone on payroll. `userId` optionally links to a profile
 * (auth.users): an office admin who logs in AND is on payroll is one
 * person represented in both tables. Field crew who never log in have
 * `userId = null`. The two aren't symmetrical — a profile isn't
 * necessarily an employee (e.g., an external auditor with a login).
 */
export const employees = pgTable(
  "employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    code: text("code").notNull(), // employee number
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    displayName: text("display_name"),

    /**
     * Optional link to the person's Groundworks login. Nullable because
     * not every employee has a login (field crew, subs on payroll, etc.).
     * onDelete: set null — deleting the profile doesn't delete the
     * employee (their payroll history is preserved).
     */
    userId: uuid("user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),

    classification:
      employeeClassification("classification").notNull().default("hourly"),
    defaultRate: numeric("default_rate", { precision: 20, scale: 4 }),
    hireDate: date("hire_date"),
    terminationDate: date("termination_date"),

    // Contact
    email: text("email"),
    phone: text("phone"),
    addresses: jsonb("addresses").notNull().default([]),

    // Minimal tax reference — the full SSN would need at-rest encryption;
    // for v1 we just store the last-4 for display, and rely on a future
    // payroll provider for the full SSN / W-4 data.
    ssnLast4: text("ssn_last4"),

    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),

    ...timestamps,
  },
  (t) => [
    uniqueIndex("employees_org_code_key").on(t.organizationId, t.code),
    uniqueIndex("employees_org_user_key").on(t.organizationId, t.userId),
  ]
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

export const employeesRelations = relations(employees, ({ one }) => ({
  organization: one(organizations, {
    fields: [employees.organizationId],
    references: [organizations.id],
  }),
  user: one(profiles, {
    fields: [employees.userId],
    references: [profiles.id],
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
export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;

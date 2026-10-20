import { boolean, index, numeric, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { accounts } from "./accounts";
import { organizations } from "./identity";

/**
 * SALES TAX, manual rates (QuickBooks' "manual sales tax").
 *
 *   agency      who the tax is owed to (a state, county, or city), and the
 *               liability account it accrues in (2200 Sales Tax Payable by
 *               default)
 *   rate        one component: a percentage owed to one agency
 *   tax code    what a document picks ("Sales tax rate" in the UI): one
 *               component (a single rate) or several (a combined rate,
 *               e.g. state + county + city)
 *
 * A document stores its own `sales_tax_lines` (rate and amount per
 * component) when it's saved, so changing a rate later never rewrites
 * history.
 */

export const taxAgencies = pgTable(
  "tax_agencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Where tax collected for this agency accrues. */
    liabilityAccountId: uuid("liability_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    registrationNumber: text("registration_number"),
    /** monthly, quarterly, or annually: informational, for the filing reminder. */
    filingFrequency: text("filing_frequency"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("tax_agencies_org_name_key").on(t.organizationId, t.name)]
);

export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => taxAgencies.id, { onDelete: "restrict" }),
    /** Percent, e.g. 6.2500 for 6.25%. */
    ratePercent: numeric("rate_percent", { precision: 9, scale: 4 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tax_rates_org_name_key").on(t.organizationId, t.name),
    index("tax_rates_agency_idx").on(t.organizationId, t.agencyId),
  ]
);

export const taxCodes = pgTable(
  "tax_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("tax_codes_org_name_key").on(t.organizationId, t.name)]
);

export const taxCodeComponents = pgTable(
  "tax_code_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    taxCodeId: uuid("tax_code_id")
      .notNull()
      .references(() => taxCodes.id, { onDelete: "cascade" }),
    taxRateId: uuid("tax_rate_id")
      .notNull()
      .references(() => taxRates.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("tax_code_components_key").on(t.taxCodeId, t.taxRateId)]
);

export type TaxAgency = typeof taxAgencies.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type TaxCode = typeof taxCodes.$inferSelect;

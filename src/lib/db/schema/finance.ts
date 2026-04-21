import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { exchangeRateType, timestamps } from "./_shared";
import { organizations } from "./identity";

/**
 * CURRENCIES — global master of ISO-4217 currencies. Not tenant-scoped; the
 * list is universal. Tenants reference by code ('USD', 'EUR', etc.).
 *
 * Storage decimals: always 4. `displayDecimals` tells the UI how to format.
 */
export const currencies = pgTable("currencies", {
  code: text("code").primaryKey(), // ISO 4217: USD, EUR, CAD, GBP, ...
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  displayDecimals: integer("display_decimals").notNull().default(2),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
});

/**
 * EXCHANGE RATES — tenant-scoped rate history keyed by (from, to, type, date).
 * Rate lookup always picks the most recent effective_date <= query date.
 *
 * `rate` = units of `to_currency` per 1 unit of `from_currency`.
 *   Example: USD→EUR 0.92 means 1 USD = 0.92 EUR.
 * `inverseRate` is stored for convenience (1 / rate) — avoids FP errors.
 */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fromCurrency: text("from_currency")
      .notNull()
      .references(() => currencies.code),
    toCurrency: text("to_currency")
      .notNull()
      .references(() => currencies.code),
    rateType: exchangeRateType("rate_type").notNull(),
    effectiveDate: date("effective_date").notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    inverseRate: numeric("inverse_rate", { precision: 20, scale: 10 }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("exchange_rates_lookup_idx").on(
      t.organizationId,
      t.fromCurrency,
      t.toCurrency,
      t.rateType,
      t.effectiveDate
    ),
    // Ensure no duplicate (org, from, to, type, date)
    uniqueIndex("exchange_rates_unique_key").on(
      t.organizationId,
      t.fromCurrency,
      t.toCurrency,
      t.rateType,
      t.effectiveDate
    ),
  ]
);

export const currenciesRelations = relations(currencies, ({ many }) => ({
  fromRates: many(exchangeRates, { relationName: "from" }),
  toRates: many(exchangeRates, { relationName: "to" }),
}));

export const exchangeRatesRelations = relations(exchangeRates, ({ one }) => ({
  organization: one(organizations, {
    fields: [exchangeRates.organizationId],
    references: [organizations.id],
  }),
  from: one(currencies, {
    fields: [exchangeRates.fromCurrency],
    references: [currencies.code],
    relationName: "from",
  }),
  to: one(currencies, {
    fields: [exchangeRates.toCurrency],
    references: [currencies.code],
    relationName: "to",
  }),
}));

export type Currency = typeof currencies.$inferSelect;
export type ExchangeRate = typeof exchangeRates.$inferSelect;
export type NewExchangeRate = typeof exchangeRates.$inferInsert;

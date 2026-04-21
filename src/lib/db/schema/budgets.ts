import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { accounts } from "./accounts";
import { dimensions, dimensionValues } from "./dimensions";
import { organizations, profiles } from "./identity";
import { fiscalPeriods, fiscalYears } from "./periods";

/**
 * BUDGETS — a named set of planned amounts for a fiscal year. Multiple
 * budgets per year are supported (plan vs. forecast vs. revised).
 *
 * `is_locked=true` freezes the budget (no entry edits). Typically set once
 * the board/owner approves the plan for the year.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    isLocked: boolean("is_locked").notNull().default(false),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => profiles.id, {
      onDelete: "set null",
    }),

    ...timestamps,
  },
  (t) => [uniqueIndex("budgets_org_code_key").on(t.organizationId, t.code)]
);

/**
 * BUDGET ENTRIES — one planned amount per (budget, account, period) and
 * optional dimension combination. Multiple entries for the same (budget,
 * account, period) are allowed when split by different dimensions
 * (e.g., budget 6600 Rent separately by Department dimension value).
 *
 * Amount can be positive OR negative — interpretation is by account
 * normal_balance. Actual vs. budget reporting compares signed local-currency
 * sums against entries in the same dimension slice.
 */
export const budgetEntries = pgTable(
  "budget_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),

    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    periodId: uuid("period_id")
      .notNull()
      .references(() => fiscalPeriods.id, { onDelete: "restrict" }),

    amount: numeric("amount", { precision: 20, scale: 4 }).notNull().default("0"),
    memo: text("memo"),

    ...timestamps,
  },
  (t) => [
    index("budget_entries_budget_idx").on(t.budgetId, t.accountId, t.periodId),
    index("budget_entries_period_idx").on(t.organizationId, t.periodId),
  ]
);

/**
 * BUDGET ENTRY DIMENSIONS — slice a budget entry by one or more dimensions.
 * Unique per (entry, dimension); one entry can have many dimensions.
 */
export const budgetEntryDimensions = pgTable(
  "budget_entry_dimensions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => budgetEntries.id, { onDelete: "cascade" }),
    dimensionId: uuid("dimension_id")
      .notNull()
      .references(() => dimensions.id, { onDelete: "restrict" }),
    valueId: uuid("value_id")
      .notNull()
      .references(() => dimensionValues.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("budget_entry_dims_key").on(t.entryId, t.dimensionId),
  ]
);

export const budgetsRelations = relations(budgets, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [budgets.organizationId],
    references: [organizations.id],
  }),
  fiscalYear: one(fiscalYears, {
    fields: [budgets.fiscalYearId],
    references: [fiscalYears.id],
  }),
  entries: many(budgetEntries),
}));

export const budgetEntriesRelations = relations(
  budgetEntries,
  ({ one, many }) => ({
    budget: one(budgets, {
      fields: [budgetEntries.budgetId],
      references: [budgets.id],
    }),
    account: one(accounts, {
      fields: [budgetEntries.accountId],
      references: [accounts.id],
    }),
    period: one(fiscalPeriods, {
      fields: [budgetEntries.periodId],
      references: [fiscalPeriods.id],
    }),
    dimensionValues: many(budgetEntryDimensions),
  })
);

export type Budget = typeof budgets.$inferSelect;
export type NewBudget = typeof budgets.$inferInsert;
export type BudgetEntry = typeof budgetEntries.$inferSelect;
export type NewBudgetEntry = typeof budgetEntries.$inferInsert;
export type BudgetEntryDimension = typeof budgetEntryDimensions.$inferSelect;
